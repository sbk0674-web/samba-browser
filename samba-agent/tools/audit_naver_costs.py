"""네이버 머니 영수증과 롯데온 적립을 대조한 뒤 확인된 원가만 정정한다."""

import argparse
import hashlib
import json
import logging
import re
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer

from samba_agent.agents.naverpay import parse_receipt
from samba_agent.agents.source_detail import actual_cost
from samba_agent.ops.crosscheck import Ledger
from samba_agent.settings import load_settings
from samba_agent.wave.client import WaveClient

KST = timezone(timedelta(hours=9))


def candidates(since):
    serde = JsonPlusSerializer()
    with sqlite3.connect('file:events.sqlite?mode=ro', uri=True) as events:
        ids = set()
        for job, raw in events.execute(
            "SELECT job_id,payload FROM events WHERE agent='supervisor' AND at>=? AND payload LIKE '%LOTTEON%'",
            (since,),
        ):
            args = json.loads(raw).get('args') or []
            if (
                args
                and isinstance(args[0], dict)
                and "source='LOTTEON'" in str(args[0].get('order'))
            ):
                ids.add(job)
    result = {}
    with sqlite3.connect('file:checkpoints.sqlite?mode=ro', uri=True) as checkpoints:
        for job in ids:
            row = checkpoints.execute(
                'SELECT type,checkpoint FROM checkpoints WHERE thread_id=? ORDER BY checkpoint_id DESC LIMIT 1',
                (f'job:{job}',),
            ).fetchone()
            if row is None:
                continue
            state = serde.loads_typed((row[0], row[1]))['channel_values']
            results = {
                name: value if isinstance(value, dict) else value.model_dump()
                for name, value in state.get('results', {}).items()
            }
            buy = (results.get('buyer.lotteon') or {}).get('payload') or {}
            saved = ((results.get('recorder') or {}).get('payload') or {}).get('values') or {}
            if '네이버' not in str(buy.get('card')) or not saved.get('source_order_no'):
                continue
            order = state['order']
            order = order if isinstance(order, dict) else order.model_dump()
            key = str(saved['source_order_no'])
            result[key] = {
                'job': job,
                'order_no': order['order_no'],
                'wave_id': order['wave_id'],
                'profile': buy['account'],
            }
            for evidence in (results.get('recorder') or {}).get('evidence', []):
                if evidence.get('label') != '실제 원가':
                    continue
                amounts = re.search(
                    r'결제 ([\d.]+) · 적립금 ([\d.]+) · 적립 ([\d.]+) · 네이버',
                    evidence.get('detail', ''),
                )
                if amounts:
                    paid, used, reward = map(float, amounts.groups())
                    if reward > 0 and reward != buy.get('reward'):
                        result[key]['verified_site_detail'] = {
                            'source_order_no': key,
                            'paid': paid,
                            'points_used': used,
                            'reward': reward,
                            'note': None,
                        }
    return result


class Browser:
    def __init__(self, settings):
        self.url = settings.bridge_url
        self.headers = {
            'X-Samba-Token': settings.bridge_token.get_secret_value(),
            'X-Samba-Window': 'naver-audit',
            'X-Samba-Lane': 'naver-audit',
        }
        self.client = httpx.Client(timeout=95)
        response = self.client.post(
            self.url + '/windows', headers=self.headers, json={'name': 'naver-audit'}
        )
        response.raise_for_status()

    def tool(self, name, /, **args):
        for attempt in range(8):
            response = self.client.post(
                self.url + '/tool/' + name, headers=self.headers, json={'args': args}
            )
            if response.status_code != 409:
                break
            time.sleep(2)
        response.raise_for_status()
        payload = response.json()
        if payload.get('ok') is not True:
            raise RuntimeError('조회 도구 실패')
        result = payload['result']
        try:
            return json.loads(result)
        except ValueError:
            if name == 'run_js' and not result.startswith('error:'):
                return result
            raise RuntimeError('조회 응답 형식 확인 필요') from None

    def page(self, url, profile, links=False):
        selector = 'a[href*="/instantPay/detail/"]' if links else None
        code = (
            'const opened=String(await tabs.open('
            + json.dumps({'profile': profile, 'url': url})
            + '));'
            'const id=(opened.match(/tab (\\S+)/)||[])[1];try{await sleep(1800);'
            'return String((await page.get('
            + json.dumps({'selector': selector} if selector else {})
            + ')).tree);}'
            'finally{if(id)await tabs.close(id);}'
        )
        text = self.tool('run_js', safety='no_pay', code=code)
        if re.search(r'URL: https://(?:nid|login)\.|captcha|접근이 제한', text, re.IGNORECASE):
            raise RuntimeError('로그인·차단 화면 — 반복 접속 중단')
        time.sleep(1)
        return text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--since', default='2026-10-22')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--pages', type=int, default=10)
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--retry-deferred', action='store_true')
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)
    settings = load_settings()
    targets = candidates(args.since)
    browser = Browser(settings)
    wave = WaveClient(
        settings.wave_url, settings.wave_internal_token.get_secret_value(), settings.wave_tenant_id
    )
    ledger = Ledger(settings.db_path.parent / 'ledger.sqlite')
    report = {
        'at_kst': datetime.now(KST).isoformat(),
        'targets': len(targets),
        'results': [],
        'deferred': [],
    }
    report_path = Path('ops/reports/naver-cost-audit-20261029.json')
    report_path.parent.mkdir(parents=True, exist_ok=True)
    if report_path.exists():
        report = json.loads(report_path.read_text(encoding='utf-8'))
        if args.retry_deferred:
            report.setdefault('previous_deferred', []).extend(report['deferred'])
            report['deferred'] = []
    visited = set()

    def save():
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')

    print('TARGETS', len(targets), flush=True)
    for profile in sorted({target['profile'] for target in targets.values()}):
        for page in range(1, args.pages + 1):
            text = browser.page(
                f'https://pay.naver.com/pc/history?page={page}', profile, links=True
            )
            links = list(
                dict.fromkeys(
                    re.findall(
                        r'href=(https://orders\.pay\.naver\.com/instantPay/detail/\d+NP\d+)', text
                    )
                )
            )
            print('HISTORY', profile, page, len(links), flush=True)
            if not links:
                break
            for url in links:
                if url in visited:
                    continue
                if any(
                    url.endswith(str(result.get('naver_receipt'))) for result in report['results']
                ):
                    continue
                visited.add(url)
                text = browser.page(url, profile)
                match = re.search(r'결제 확인 번호\s*[:：]?\s*(\d+)', text)
                if not match or match.group(1) not in targets:
                    continue
                source_no = match.group(1)
                target = targets[source_no]
                if target['profile'] != profile:
                    continue
                try:
                    receipt = parse_receipt(text, source_no)
                    site = target.get('verified_site_detail')
                    site_evidence = '기존 롯데온 상세 실기록(견적 적립 대체 아님)'
                    if site is None:
                        site = browser.tool(
                            'run_script',
                            name='lotteon_order_detail',
                            args=json.dumps({'source_order_no': source_no, 'profile': profile}),
                        )
                        site_evidence = '롯데온 현재 주문 상세 직접 조회'
                    if (
                        site.get('source_order_no') != source_no
                        or site.get('paid') != receipt['paid']
                        or site.get('note')
                    ):
                        raise ValueError('롯데온 주문번호·실결제액·상세 판독 불일치')
                    if target.get('verified_site_detail') is None and site.get('status') not in (
                        '결제완료',
                        '상품준비중',
                        '출고지시',
                        '배송중',
                        '배송완료',
                        '구매확정',
                    ):
                        raise ValueError('취소·반품 등 상태 별도 확인 필요')
                    if not isinstance(site.get('reward'), int | float) or site['reward'] <= 0:
                        raise ValueError('롯데온 자체 적립 0원 여부 별도 확인 필요')
                    cost = actual_cost({**site, **receipt})
                    before = wave._request('GET', '/orders/' + target['wave_id'])
                    if before.get('sourcing_order_number') != source_no or before.get('status') in (
                        'pending',
                        'cancelled',
                        'returning',
                        'returned',
                        'cancelling',
                    ):
                        raise ValueError('현재 삼바 구매번호·상태 불일치')
                    record = {
                        **target,
                        **receipt,
                        'site_evidence': site_evidence,
                        'site_reward': site['reward'],
                        'points_used': site['points_used'],
                        'old_cost': before['cost'],
                        'new_cost': cost,
                        'applied': False,
                    }
                    if args.apply and before['cost'] != cost:
                        ledger.put(
                            target['order_no'],
                            source_no,
                            cost,
                            before.get('shipping_fee') or 0,
                            profile,
                            'LOTTEON',
                            wave_id=target['wave_id'],
                        )
                        note = f'[원가 정정] 네이버 영수증 {receipt["naver_receipt"]} · 수단 {receipt["card"]} · 카드 사용 {receipt["card_paid"]}원 / 머니 사용 {receipt["money_paid"]}원 · 네이버 적립 {receipt["naver_reward"]}원 · 롯데온 적립 {site["reward"]}원 · 기존 {before["cost"]}→{cost}원 · 실제 카드 사용액만 청구할인 적용 · 재결제 없음'
                        try:
                            wave.record_sourcing(
                                target['wave_id'],
                                sourcing_order_number=source_no,
                                cost=cost,
                                shipping_fee=before.get('shipping_fee') or 0,
                                notes=note,
                            )
                        except Exception:
                            ledger.put(
                                target['order_no'],
                                source_no,
                                before['cost'],
                                before.get('shipping_fee') or 0,
                                profile,
                                'LOTTEON',
                                wave_id=target['wave_id'],
                            )
                            raise
                        after = wave._request('GET', '/orders/' + target['wave_id'])
                        preserve = (
                            'sourcing_order_number',
                            'status',
                            'sourcing_account_id',
                            'shipping_fee',
                            'action_tag',
                            'paid_at',
                            'shipping_status',
                        )
                        if after['cost'] != cost or not all(
                            before.get(key) == after.get(key) for key in preserve
                        ):
                            raise RuntimeError('정정 후 금액·기존 필드 보존 검증 실패')
                        if before.get('notes') and before['notes'] not in after.get('notes', ''):
                            raise RuntimeError('기존 메모 보존 검증 실패')
                        record['applied'] = True
                        record['previous_notes_sha256'] = hashlib.sha256(
                            str(before.get('notes') or '').encode()
                        ).hexdigest()
                    report['results'].append(record)
                    print(
                        'VERIFIED', source_no, before['cost'], cost, record['applied'], flush=True
                    )
                except ValueError as exc:
                    report['deferred'].append({'source_order_no': source_no, 'reason': str(exc)})
                    print('DEFERRED', source_no, str(exc), flush=True)
                save()
                if args.limit and len(report['results']) >= args.limit:
                    return
            if all(
                any(
                    result['source_order_no'] == key
                    for result in report['results'] + report['deferred']
                )
                for key, target in targets.items()
                if target['profile'] == profile
            ):
                break
    save()
    print(
        'FINISHED',
        len(report['results']),
        len(report['deferred']),
        'unmatched',
        len(targets) - len(report['results']) - len(report['deferred']),
        flush=True,
    )


if __name__ == '__main__':
    main()
