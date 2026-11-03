// The top of a business page. Used for the public page and for the owner's live preview, so it
// takes plain values and has no hooks. Order is fixed: cover, logo, name, owners, tagline,
// chips, story. Owner text is plain text; React escapes it and CSS keeps the line breaks.

export interface AboutData {
  name: string;
  owner_display: string;
  owner_line?: string | null;
  owner_photo_url?: string | null;
  tagline?: string | null;
  story?: string | null;
  neighborhood?: string | null;
  city: string;
  status_line?: string | null;
  logo_url?: string | null;
  cover_url?: string | null;
}

export function AboutCard({ b }: { b: AboutData }) {
  const initial = b.name.trim().charAt(0).toUpperCase() || "•";
  return (
    <header className="about">
      {b.cover_url ? <img className="cover" src={b.cover_url} alt="" /> : <div className="cover cover-empty" aria-hidden="true" />}
      <div className="about-body">
        {b.logo_url ? (
          <img className="logo" src={b.logo_url} alt={`${b.name} logo`} width={72} height={72} />
        ) : (
          <div className="logo logo-letter" aria-hidden="true">{initial}</div>
        )}
        <h1 className="biz-name">{b.name}</h1>
        <div className="owners">
          {b.owner_photo_url && <img className="owner-photo" src={b.owner_photo_url} alt="" width={40} height={40} />}
          <p>
            <strong>{b.owner_display}</strong>
            {b.owner_line ? <span className="muted"> · {b.owner_line}</span> : null}
          </p>
        </div>
        {b.tagline && <p className="tagline">{b.tagline}</p>}
        <ul className="chips" aria-label="About">
          {b.neighborhood && <li className="chip">{b.neighborhood}, {b.city}</li>}
          {!b.neighborhood && <li className="chip">{b.city}</li>}
          {b.status_line && <li className="chip chip-status">{b.status_line}</li>}
        </ul>
        {b.story && <p className="story">{b.story}</p>}
      </div>
    </header>
  );
}
