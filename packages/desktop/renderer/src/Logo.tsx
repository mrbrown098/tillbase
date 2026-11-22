import { useApp } from "./context";

/** The Tillbase mark: a bold T whose stem ends in a till-drawer pull. Original artwork, same as the app icon. */
export function TillbaseMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" role="img" aria-label="Tillbase" className="mark">
      <defs>
        <linearGradient id="tb-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#14877e" />
          <stop offset="1" stopColor="#0b5550" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="208" fill="url(#tb-bg)" />
      <rect x="212" y="248" width="600" height="156" rx="40" fill="#fff" />
      <rect x="434" y="372" width="156" height="408" rx="40" fill="#fff" />
      <rect x="384" y="664" width="256" height="116" rx="38" fill="#f5a524" />
      <rect x="452" y="700" width="120" height="30" rx="15" fill="#0b5550" />
    </svg>
  );
}

/** The shop's own logo when it has uploaded one, otherwise the Tillbase mark. */
export function ShopLogo({ size = 40 }: { size?: number }) {
  const { settings } = useApp();
  if (settings.businessLogo) {
    return <img className="shop-logo" src={settings.businessLogo} alt={`${settings.storeName} logo`} style={{ height: size, maxWidth: size * 3 }} />;
  }
  return <TillbaseMark size={size} />;
}
