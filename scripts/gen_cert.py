"""(Re)generate the self-signed HTTPS certificate, e.g. after your LAN IP changes.

    python scripts/gen_cert.py [extra-ip ...]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings  # noqa: E402
from app.network import ensure_self_signed_cert, lan_ip  # noqa: E402

if __name__ == "__main__":
    settings.cert_file.unlink(missing_ok=True)
    settings.key_file.unlink(missing_ok=True)
    ensure_self_signed_cert(settings.cert_file, settings.key_file, extra_ips=sys.argv[1:])
    print(f"Wrote {settings.cert_file} and {settings.key_file} (LAN IP {lan_ip()})")
