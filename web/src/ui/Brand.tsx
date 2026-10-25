export function Brand({ onClick }: { onClick?: () => void }) {
  const content = (
    <>
      <LogoMark />
      <span>Lumi</span>
    </>
  );
  return onClick ? (
    <button type="button" className="lumi-brand" onClick={onClick} aria-label="Lumi, back to the start">
      {content}
    </button>
  ) : (
    <div className="lumi-brand">{content}</div>
  );
}

export function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" aria-hidden>
      <path d="M6.8 20.2c0-7.4 4.8-13.1 11.6-13.1 4.3 0 7.5 2.1 7.5 5.6 0 3.1-2.3 5.1-5.9 5.1h-2.5c-2.2 0-3.4 1.1-3.4 2.9 0 2 1.6 3.4 4 3.4 2.8 0 5.1-1.3 7-3.8-.7 6-4.5 9.2-10 9.2-5 0-8.3-3.6-8.3-9.3Z" fill="currentColor" />
      <path d="M5.4 7.7c2.3.6 4 2.3 4.6 4.6.6-2.3 2.3-4 4.6-4.6-2.3-.6-4-2.3-4.6-4.6-.6 2.3-2.3 4-4.6 4.6Z" fill="currentColor" />
    </svg>
  );
}
