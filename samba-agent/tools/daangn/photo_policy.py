"""무신사 사진 업로드 전 검사. 파일을 읽기만 하며 기기에 접근하지 않는다."""
from pathlib import Path
import re
from urllib.parse import urlsplit

from PIL import Image


def is_musinsa_item(item):
    musinsa_pid = any(str(item.get(key) or '').lower().startswith('musinsa')
                     for key in ('pid', 'source_pid', 'sourcepid'))
    host = (urlsplit(str(item.get('source_url') or '')).hostname or '').lower()
    return musinsa_pid or host == 'musinsa.com' or host.endswith('.musinsa.com')


def validate_photo_policy(item):
    if not is_musinsa_item(item):
        return

    images = item.get('images')
    if not isinstance(images, (list, tuple)) or len(images) < 2:
        raise ValueError('무신사 사진: 첫 썸네일 한 장과 검수 태그 사진 필요')
    for index, name in enumerate(images):
        role = 'main' if index == 0 else 'tag'
        if not isinstance(name, str) or not re.fullmatch(
                rf'(?:\d+[-_])?{role}(?:[-_]?\d+)?', Path(name).stem.lower()):
            raise ValueError('무신사 사진: 첫 사진은 main, 이후는 tag만 허용')
        if not Path(name).is_absolute():
            raise ValueError('무신사 사진: 절대 경로 필요')
    if item.get('photo_rotation_clockwise_degrees') != 2:
        raise ValueError('무신사 사진: 시계방향 2도 회전 기록 필요')
    if item.get('photo_crop_fraction') != .9 or item.get('photo_square') is not True:
        raise ValueError('무신사 사진: 90% 크롭·정사각형 처리 기록 필요')
    for name in images:
        with Image.open(name) as image:
            if image.width != image.height:
                raise ValueError('무신사 사진: 실제 사진이 정사각형 아님')
            if image.getexif() or image.info.get('exif'):
                raise ValueError('무신사 사진: EXIF가 남아 있어 업로드 중지')
            image.load()
