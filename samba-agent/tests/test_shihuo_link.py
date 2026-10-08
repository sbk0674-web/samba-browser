# 식화 판매처 링크 읽기 — 2026-10-08 실측 응답 모양으로
import json
import urllib.parse

import pytest

from samba_agent.ops.shihuo_link import (
    ShihuoLinkError,
    ids_from_url,
    parse_suppliers,
    sku_id_of,
    whitelisted_taobao,
)

ITEM = (
    'https://item.taobao.com/item.htm?id=1061771457452&dspm=&fromShType=1&goodsType=4'
    '&shopId=cn.taobao.220638605&skuId=6107122221658&discount_price=549'
)


def _href(url: str) -> str:
    return (
        'shihuo://www.shihuo.cn?route=go&need_login=&goods_product_id=395390827&url='
        + urllib.parse.quote(url, safe='')
    )


def _payload() -> dict:
    def row(store: str, name: str, price: str, url: str = '') -> dict:
        info = {'store_name': store, 'supplier_name': name, 'display_price': price}
        if url:
            info['href'] = _href(url)
        return {'supplier_info': info}

    return {
        'data': {
            'list': [
                row('唯品会', '唯品会', '700'),
                row('淘宝', '鞋之正义', '650', 'https://item.taobao.com/item.htm?id=999'),
                row('淘宝', '后浪潮品奥莱折扣店', '520', ITEM),
                row('得物', '得物', '650'),
            ]
        }
    }


def test_판매처_행을_싼_순으로_읽고_href_의_url_파라미터를_푼다():
    rows = parse_suppliers(_payload())
    assert [r.price_cny for r in rows] == [520, 650, 650, 700]
    assert rows[0].name == '后浪潮品奥莱折扣店' and rows[0].url == ITEM


def test_화이트리스트_淘宝_가게만_남긴다_블랙리스트_가게는_뺀다():
    rows = whitelisted_taobao(parse_suppliers(_payload()))
    assert [r.name for r in rows] == ['后浪潮品奥莱折扣店']


def test_상품_주소가_없는_행은_淘宝_구매_후보가_아니다():
    payload = _payload()
    payload['data']['list'][2]['supplier_info'].pop('href')
    assert whitelisted_taobao(parse_suppliers(payload)) == []


def test_식화_주소에서_goods_style을_읽는다():
    url = 'https://www.shihuo.cn/page/pcGoodsDetail?goodsId=760551&styleId=161281956'
    assert ids_from_url(url) == ('760551', '161281956')
    with pytest.raises(ShihuoLinkError):
        ids_from_url('https://www.shihuo.cn/page/pcGoodsDetail')


def test_사이즈의_식화_sku를_고른다():
    data = {
        'props': {
            'pageProps': {
                'skuListData': {
                    'data': {
                        'list': [
                            {
                                'sku_list': [
                                    {
                                        'sku_id': '395390827',
                                        'attrs': [
                                            {'spec_name': '颜色', 'name': '粉色/银色'},
                                            {'spec_name': '尺码', 'name': '37'},
                                        ],
                                    },
                                    {
                                        'sku_id': '395390772',
                                        'attrs': [{'spec_name': '尺码', 'name': '38'}],
                                    },
                                ]
                            }
                        ]
                    }
                }
            }
        }
    }
    html = f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(data)}</script>'
    assert sku_id_of(html, '37') == '395390827'
    with pytest.raises(ShihuoLinkError):
        sku_id_of(html, '45')
