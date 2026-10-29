import importlib.util
import ast
from pathlib import Path
from types import SimpleNamespace

from PIL import Image
import pytest


@pytest.mark.parametrize('pid, order', [
    ('musinsa-123', [0, 1, 2]), ('bunjang-123', [2, 0, 1]),
])
def test_stale_main_mapping_cannot_move_musinsa_thumbnail(tmp_path, monkeypatch, pid, order):
    policy_path = Path(__file__).parents[1] / 'tools/daangn/photo_policy.py'
    spec = importlib.util.spec_from_file_location('photo_policy', policy_path)
    policy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(policy)
    monkeypatch.setitem(__import__('sys').modules, 'photo_policy', policy)
    post_path = policy_path.with_name('post.py')
    function = next(node for node in ast.parse(post_path.read_text(encoding='utf8')).body
                    if isinstance(node, ast.FunctionDef) and node.name == 'push_images')
    pushed = []

    def run(args, **kwargs):
        pushed.append(args[4])

    namespace = {
        'sh': lambda *args: SimpleNamespace(stdout=b''), 'MAIN': {pid: 3},
        'os': SimpleNamespace(path=SimpleNamespace(exists=lambda path: False)),
        'subprocess': SimpleNamespace(run=run), 'ADB': 'unused', 'DEV': 'unused',
        'time': SimpleNamespace(time=lambda: 1234567890),
    }
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(post_path), 'exec'), namespace)
    item = item_with_photos(tmp_path)
    item['pid'] = pid
    assert namespace['push_images'](item) == 3
    assert pushed == [item['images'][index] for index in order]


def load_policy():
    spec = importlib.util.spec_from_file_location(
        'photo_policy', Path(__file__).parents[1] / 'tools/daangn/photo_policy.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_photo_policy


def item_with_photos(tmp_path, *, size=(20, 20), exif=False):
    images = []
    for name in ('01-main.jpg', '02-tag.jpg', '03-tag.jpg'):
        path = tmp_path / name
        image = Image.new('RGB', size)
        metadata = Image.Exif()
        if exif:
            metadata[274] = 1
        image.save(path, **({'exif': metadata} if exif else {}))
        images.append(str(path))
    return {'pid': 'musinsa-123', 'images': images,
            'photo_rotation_clockwise_degrees': 2,
            'photo_crop_fraction': .9, 'photo_square': True}


def test_valid_prepared_photos_pass_without_changing_item(tmp_path):
    item = item_with_photos(tmp_path)
    before = dict(item)
    load_policy()(item)
    assert item == before


def test_numbered_main_and_tag_filenames_pass(tmp_path):
    item = item_with_photos(tmp_path)
    paths = []
    for old, name in zip(item['images'], ('main1.jpg', 'tag1.jpg', 'tag2.jpg')):
        path = tmp_path / name
        Path(old).rename(path)
        paths.append(str(path))
    item['images'] = paths
    load_policy()(item)


@pytest.mark.parametrize('key', ['source_pid', 'sourcepid'])
def test_source_pid_also_applies_guard(key):
    with pytest.raises(ValueError):
        load_policy()({'pid': '123', key: 'musinsa-123'})


@pytest.mark.parametrize('field,value', [
    ('photo_rotation_clockwise_degrees', None),
    ('photo_rotation_clockwise_degrees', -2),
    ('photo_crop_fraction', 1), ('photo_square', False),
])
def test_missing_processing_evidence_blocks(tmp_path, field, value):
    item = item_with_photos(tmp_path)
    item[field] = value
    with pytest.raises(ValueError):
        load_policy()(item)


@pytest.mark.parametrize('size,exif', [((20, 10), False), ((20, 20), True)])
def test_actual_rectangle_or_exif_blocks(tmp_path, size, exif):
    with pytest.raises(ValueError):
        load_policy()(item_with_photos(tmp_path, size=size, exif=exif))


@pytest.mark.parametrize('names', [
    ('01-main.jpg', '02-back.jpg'),
    ('01-main.jpg', '02-main.jpg'),
    ('01-back.jpg', '02-tag.jpg'),
    ('01-main.jpg',),
])
def test_back_or_extra_main_or_missing_tag_blocks(tmp_path, names):
    item = item_with_photos(tmp_path)
    item['images'] = [str(tmp_path / name) for name in names]
    with pytest.raises(ValueError):
        load_policy()(item)


@pytest.mark.parametrize('host', ['musinsa.com', 'www.musinsa.com', 'used.musinsa.com'])
def test_musinsa_url_applies_guard_even_with_legacy_pid(host):
    with pytest.raises(ValueError):
        load_policy()({'pid': '123', 'source_url': f'https://{host}/item/1'})


@pytest.mark.parametrize('url', ['https://m.bunjang.co.kr/products/1',
                               'https://musinsa.com.example.org/item/1'])
def test_other_source_is_untouched(url):
    load_policy()({'pid': '123', 'source_url': url})
