"""Helpers for finding this machine on the LAN and creating a self-signed TLS cert.

Phone browsers only allow getUserMedia() on secure origins (https:// or localhost),
so the server must speak HTTPS even on the local Wi-Fi network.
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import os
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def lan_ip() -> str:
    """This machine's IP on the local network (override with PUBLIC_HOST).

    Connecting a UDP socket sends no packets; it only makes the OS pick the
    outbound interface, whose address we then read back.
    """
    override = os.getenv("PUBLIC_HOST", "").strip()
    if override:
        return override
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def ensure_self_signed_cert(cert_file: Path, key_file: Path, extra_ips: list[str] | None = None) -> bool:
    """Create a self-signed cert valid for localhost + the LAN IP. Returns True if created."""
    if cert_file.exists() and key_file.exists():
        return False

    cert_file.parent.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    hostname = socket.gethostname()
    ips = {"127.0.0.1", *(extra_ips or [])}
    host = lan_ip()
    try:
        ipaddress.ip_address(host)
        ips.add(host)
    except ValueError:  # PUBLIC_HOST may be a hostname
        extra_dns = {host}
    else:
        extra_dns = set()
    dns_names = {"localhost", hostname, hostname if hostname.endswith(".local") else f"{hostname}.local", *extra_dns}
    san = [x509.DNSName(n) for n in sorted(dns_names)] + [
        x509.IPAddress(ipaddress.ip_address(ip)) for ip in sorted(ips)
    ]

    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "phone-cam-webrtc (local dev)")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5))
        .not_valid_after(now + dt.timedelta(days=825))
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )

    key_file.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return True
