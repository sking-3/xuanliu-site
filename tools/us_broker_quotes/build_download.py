"""Build/check the explicit, credential-free standalone helper download."""
from io import BytesIO
from pathlib import Path
import sys
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

SOURCE = Path(__file__).resolve().parent
TARGET = SOURCE.parents[1] / 'downloads/books-free-broker-quotes.zip'
FILES = ('server.py', 'providers.py', 'README.md', 'requirements-futu.txt', 'requirements-tiger.txt')


def artifact():
    buffer = BytesIO()
    with ZipFile(buffer, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in FILES:
            info = ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, (SOURCE / name).read_bytes())
    return buffer.getvalue()


if __name__ == '__main__':
    data = artifact()
    if sys.argv[1:] == ['--check']:
        if not TARGET.exists() or TARGET.read_bytes() != data:
            raise SystemExit('Standalone helper is missing or stale; rebuild it.')
        print('Standalone helper matches all five source files.')
    elif not sys.argv[1:]:
        TARGET.parent.mkdir(exist_ok=True)
        TARGET.write_bytes(data)
        print('Built credential-free standalone helper:', len(data), 'bytes')
    else:
        raise SystemExit('Usage: python3 build_download.py [--check]')
