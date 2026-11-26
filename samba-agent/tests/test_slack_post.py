from samba_agent.ops.slack_post import SlackChannelPoster


class _Client:
    def __init__(self, fail_first: bool = False) -> None:
        self.posts: list[tuple[str, str]] = []
        self.joined: list[str] = []
        self._fail_first = fail_first

    def conversations_list(self, **_kw):
        return {'channels': [{'name': 'other', 'id': 'C000000001'}, {'name': 'daily_brief', 'id': 'C0DAILY99'}]}

    def chat_postMessage(self, channel, text):  # noqa: N802 — 슬랙 SDK 이름
        if self._fail_first:
            self._fail_first = False
            raise RuntimeError('not_in_channel')
        self.posts.append((channel, text))

    def conversations_join(self, channel):
        self.joined.append(channel)


class _App:
    def __init__(self, client) -> None:
        self.client = client


def test_이름으로_채널을_찾아_글을_올린다():
    client = _Client()
    assert SlackChannelPoster(_App(client), '#daily_brief').post('잔액 알림') is True
    assert client.posts == [('C0DAILY99', '잔액 알림')]


def test_채널이_없으면_False():
    client = _Client()
    assert SlackChannelPoster(_App(client), '#없는채널').post('x') is False
    assert client.posts == []


def test_봇이_채널에_없으면_들어간_뒤_다시_올린다():
    client = _Client(fail_first=True)
    assert SlackChannelPoster(_App(client), 'daily_brief').post('x') is True
    assert client.joined == ['C0DAILY99']
    assert len(client.posts) == 1


def test_슬랙_오류는_False로_돌려준다():
    class Boom(_Client):
        def chat_postMessage(self, channel, text):  # noqa: N802
            raise RuntimeError('ratelimited')

    assert SlackChannelPoster(_App(Boom()), 'daily_brief').post('x') is False
