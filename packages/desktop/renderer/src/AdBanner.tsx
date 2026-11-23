import { useEffect, useState } from "react";
import type { AdView } from "../../electron/ads";
import { api } from "./api";

/** The link people can use to ask about sponsoring. */
const SPONSOR_INFO = "https://github.com/mrbrown098/tillbase/blob/main/ads/README.md";

/**
 * One slim, clearly labelled sponsor line. It is placed only on screens where nobody is in the middle of a
 * sale or a payment, never loads anything but a still picture, and says nothing at all when there is no
 * sponsor or no internet.
 */
export function AdBanner() {
  const [ad, setAd] = useState<AdView | null>(null);

  useEffect(() => {
    let live = true;
    api
      .sponsorBanner()
      .then((a) => live && setAd(a))
      .catch(() => live && setAd(null));
    return () => {
      live = false;
    };
  }, []);

  if (!ad) return null;
  return (
    <aside className="sponsor" aria-label="Sponsored">
      <span className="sponsor-tag">Sponsored</span>
      <button className="sponsor-body" onClick={() => void api.openSponsor(ad.id)} title={`Opens ${ad.sponsor} in your browser`}>
        {ad.image && <img src={ad.image} alt="" />}
        <span>
          <strong>{ad.sponsor}</strong> {ad.text}
        </span>
      </button>
      <a className="sponsor-info" href={SPONSOR_INFO} target="_blank" rel="noreferrer noopener">
        Advertise here
      </a>
    </aside>
  );
}
