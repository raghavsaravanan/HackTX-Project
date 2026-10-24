"""Start the servers and print the URLs to open.

    python run.py

Two listeners share one app (and so one signaling hub and frame buffer):

* https://<lan-ip>:8443  - for the phone. Phones only allow getUserMedia() on secure
  origins, so this uses a self-signed certificate (accept the warning once).
* http://localhost:8000  - for the laptop viewer. Browsers treat localhost as a secure
  origin, so no certificate (and no "might be impersonating localhost" warning) is needed.
  Bound to 127.0.0.1 only, so it is not reachable from the network.
"""

from __future__ import annotations

import asyncio
import logging

import qrcode
import uvicorn

from app.config import settings
from app.main import app
from app.network import ensure_self_signed_cert, lan_ip


async def serve() -> None:
    https = uvicorn.Server(uvicorn.Config(
        app,
        host=settings.host,
        port=settings.port,
        ssl_certfile=str(settings.cert_file),
        ssl_keyfile=str(settings.key_file),
        log_level="info",
    ))
    http = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=settings.http_port, log_level="info"))
    # Only one server should install signal handlers; let the HTTPS one own Ctrl+C.
    http.install_signal_handlers = lambda: None
    https_task = asyncio.create_task(https.serve())
    http_task = asyncio.create_task(http.serve())
    await https_task
    http.should_exit = True
    await http_task


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if ensure_self_signed_cert(settings.cert_file, settings.key_file):
        print(f"Created self-signed certificate in {settings.cert_dir}/")

    phone = f"https://{lan_ip()}:{settings.port}/phone"
    viewer = f"http://localhost:{settings.http_port}/viewer"
    print("\n  Laptop viewer : " + viewer + "   (open on this Mac)")
    print("  Phone camera  : " + phone + "   (accept the certificate warning on the phone)\n")
    qr = qrcode.QRCode(border=1)
    qr.add_data(phone)
    qr.print_ascii(invert=True)

    asyncio.run(serve())


if __name__ == "__main__":
    main()
