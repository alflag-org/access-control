export const systemStyles = String.raw`
:root {
  color-scheme: light;
  --color-bg: oklch(1 0 0);
  --color-surface: oklch(0.975 0.004 252);
  --color-surface-strong: oklch(0.945 0.008 252);
  --color-ink: oklch(0.22 0.025 252);
  --color-muted: oklch(0.46 0.025 252);
  --color-border: oklch(0.87 0.012 252);
  --color-primary: oklch(0.478 0.136 251.8);
  --color-primary-hover: oklch(0.405 0.13 251.8);
  --color-primary-soft: oklch(0.94 0.035 251.8);
  --color-success: oklch(0.39 0.11 153);
  --color-success-soft: oklch(0.94 0.04 153);
  --color-warning: oklch(0.38 0.095 72);
  --color-warning-soft: oklch(0.94 0.055 82);
  --color-danger: oklch(0.46 0.16 28);
  --color-danger-soft: oklch(0.95 0.035 28);
  --radius-sm: 0.35rem;
  --radius-md: 0.65rem;
  --radius-lg: 0.95rem;
  --shadow-float: 0 0.8rem 2rem oklch(0.22 0.025 252 / 0.1);
  --focus-ring: 0 0 0 3px oklch(0.75 0.11 251.8 / 0.5);
  --content-width: 78rem;
  --ease-state: cubic-bezier(0.25, 1, 0.5, 1);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

* { box-sizing: border-box; }
.visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0 0 0 0) !important; white-space: nowrap !important; border: 0 !important; }
html { background: var(--color-bg); scroll-behavior: smooth; }
body { margin: 0; min-width: 0; color: var(--color-ink); background: var(--color-bg); line-height: 1.55; }
body, button, input, select, textarea { font: inherit; }
a { color: var(--color-primary); text-underline-offset: 0.16em; }
a:hover { color: var(--color-primary-hover); }
img, svg { max-width: 100%; }
button, input, select, textarea { min-height: 2.65rem; }
button, input, select, textarea, a { border-radius: var(--radius-sm); }
:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; box-shadow: var(--focus-ring); }

.skip-link { position: fixed; inset: 0 auto auto 1rem; z-index: 40; transform: translateY(-150%); background: var(--color-ink); color: white; padding: .65rem 1rem; }
.skip-link:focus { transform: translateY(.75rem); }
.app-header { position: sticky; top: 0; z-index: 20; border-bottom: 1px solid var(--color-border); background: oklch(1 0 0 / .96); backdrop-filter: blur(14px); }
.header-inner { max-width: var(--content-width); margin: 0 auto; padding: .8rem clamp(1rem, 3vw, 2rem); display: flex; gap: 1.25rem; align-items: center; justify-content: space-between; }
.brand { display: flex; align-items: center; gap: .7rem; color: var(--color-ink); font-weight: 720; text-decoration: none; letter-spacing: -.015em; }
.brand-mark { display: grid; place-items: center; width: 1.75rem; height: 1.75rem; border-radius: .48rem; background: var(--color-primary); color: white; font-size: .78rem; }
.primary-nav { display: flex; align-items: center; gap: .25rem; flex-wrap: wrap; }
.primary-nav a { color: var(--color-muted); font-size: .9rem; font-weight: 620; padding: .48rem .68rem; text-decoration: none; }
.primary-nav a:hover { color: var(--color-ink); background: var(--color-surface); }
.primary-nav a[aria-current="page"] { color: var(--color-primary); background: var(--color-primary-soft); }
.header-actions { display: flex; align-items: center; gap: .5rem; min-width: 0; margin-left: auto; white-space: nowrap; }
.account-link { display: flex; align-items: center; gap: .45rem; min-width: 0; max-width: 15rem; min-height: 2.4rem; padding: .42rem .58rem; border: 1px solid var(--color-border); color: var(--color-muted); font-size: .88rem; font-weight: 620; text-decoration: none; }
.account-link svg { flex: 0 0 auto; }
.account-link:hover { color: var(--color-ink); background: var(--color-surface); }
.account-link[aria-current="page"] { border-color: oklch(0.78 0.06 251.8); color: var(--color-primary); background: var(--color-primary-soft); }
.account-name { overflow: hidden; text-overflow: ellipsis; }

.layout { max-width: var(--content-width); margin: 0 auto; display: grid; grid-template-columns: minmax(11rem, 14rem) minmax(0, 1fr); gap: clamp(1.5rem, 4vw, 3rem); padding: clamp(1.5rem, 4vw, 3rem) clamp(1rem, 3vw, 2rem) 4rem; }
.side-nav { align-self: start; position: sticky; top: 5.25rem; display: grid; gap: .25rem; }
.side-nav h2 { margin: 0 0 .65rem; font-size: .78rem; color: var(--color-muted); }
.side-nav a { padding: .52rem .65rem; color: var(--color-muted); text-decoration: none; font-size: .9rem; }
.side-nav a:hover { color: var(--color-ink); background: var(--color-surface); }
.side-nav a[aria-current="page"] { color: var(--color-primary); background: var(--color-primary-soft); font-weight: 650; }
main { min-width: 0; }
.page-header { display: flex; align-items: end; justify-content: space-between; gap: 1rem; margin-bottom: 1.8rem; }
.page-header-copy { min-width: 0; }
.page-header h1 { margin: 0; font-size: 2rem; line-height: 1.15; letter-spacing: -.035em; text-wrap: balance; overflow-wrap: anywhere; }
.page-header p { max-width: 68ch; margin: .55rem 0 0; color: var(--color-muted); text-wrap: pretty; }
.section { margin-top: 2.25rem; }
.section-first { margin-top: 0; }
.section-header { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .85rem; }
.section h2 { margin: 0; font-size: 1.15rem; line-height: 1.3; letter-spacing: -.015em; }
.count { color: var(--color-muted); font-variant-numeric: tabular-nums; font-size: .85rem; }

.application-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(17rem, 100%), 1fr)); gap: 1rem; }
.application-card { min-width: 0; display: flex; flex-direction: column; gap: .9rem; padding: 1.15rem; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-bg); transition: border-color 180ms var(--ease-state), box-shadow 180ms var(--ease-state), transform 180ms var(--ease-state); }
.application-card:hover { border-color: oklch(0.7 0.06 251.8); box-shadow: var(--shadow-float); transform: translateY(-2px); }
.application-card h2 { margin: 0; font-size: 1.08rem; overflow-wrap: anywhere; }
.application-card p { margin: 0; color: var(--color-muted); overflow-wrap: anywhere; }
.card-meta { display: flex; gap: .45rem; align-items: center; flex-wrap: wrap; }
.card-actions { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-top: auto; }
.category { color: var(--color-muted); font-size: .8rem; }

.button { display: inline-flex; align-items: center; justify-content: center; gap: .45rem; min-height: 2.55rem; padding: .56rem .9rem; border: 1px solid transparent; border-radius: var(--radius-sm); font-weight: 680; font-size: .9rem; text-decoration: none; cursor: pointer; transition: background-color 180ms var(--ease-state), border-color 180ms var(--ease-state), transform 120ms var(--ease-state); }
.button:active { transform: translateY(1px); }
.button-primary { color: white; background: var(--color-primary); }
.button-primary:hover { color: white; background: var(--color-primary-hover); }
.button-secondary { color: var(--color-ink); background: var(--color-bg); border-color: var(--color-border); }
.button-secondary:hover { background: var(--color-surface); border-color: oklch(0.72 0.04 252); }
.button-danger { color: white; background: var(--color-danger); }
.button:disabled, .button[aria-disabled="true"] { opacity: .56; cursor: not-allowed; transform: none; }

.status { display: inline-flex; align-items: center; gap: .38rem; max-width: 100%; padding: .25rem .5rem; border-radius: 999px; font-size: .78rem; font-weight: 680; line-height: 1.25; white-space: nowrap; }
.status::before { content: ""; flex: 0 0 auto; width: .45rem; height: .45rem; border-radius: 50%; background: currentColor; }
.status-success { color: var(--color-success); background: var(--color-success-soft); }
.status-warning { color: var(--color-warning); background: var(--color-warning-soft); }
.status-danger { color: var(--color-danger); background: var(--color-danger-soft); }
.status-info { color: var(--color-primary); background: var(--color-primary-soft); }
.status-neutral { color: var(--color-muted); background: var(--color-surface-strong); }
.tag { display: inline-flex; max-width: 100%; padding: .23rem .48rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg); color: var(--color-muted); font-size: .78rem; overflow-wrap: anywhere; }

.notice { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: .75rem; padding: .95rem 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.notice-symbol { font-weight: 800; color: var(--color-primary); }
.notice-warning { background: var(--color-warning-soft); border-color: oklch(0.8 0.075 82); }
.notice-danger { background: var(--color-danger-soft); border-color: oklch(0.8 0.07 28); }
.notice p { margin: .2rem 0 0; color: var(--color-muted); }
.empty-state { padding: clamp(2rem, 6vw, 4rem) 1.2rem; border: 1px dashed var(--color-border); border-radius: var(--radius-lg); text-align: center; background: var(--color-surface); }
.empty-state h2 { margin: 0; font-size: 1.1rem; }
.empty-state p { max-width: 55ch; margin: .5rem auto 0; color: var(--color-muted); }
.empty-state p:only-child { margin-top: 0; }

.table-scroll { max-width: 100%; overflow-x: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg); }
table { width: 100%; min-width: 42rem; border-collapse: collapse; font-size: .88rem; }
th, td { padding: .72rem .8rem; text-align: left; vertical-align: top; border-bottom: 1px solid var(--color-border); overflow-wrap: anywhere; }
th { color: var(--color-muted); background: var(--color-surface); font-size: .78rem; font-weight: 720; }
tr:last-child td { border-bottom: 0; }
td code { word-break: break-all; }
.detail-list { display: grid; grid-template-columns: minmax(9rem, .4fr) minmax(0, 1fr); margin: 0; border-top: 1px solid var(--color-border); }
.detail-list dt, .detail-list dd { margin: 0; padding: .75rem 0; border-bottom: 1px solid var(--color-border); overflow-wrap: anywhere; }
.detail-list dt { color: var(--color-muted); padding-right: 1rem; }
.provenance { padding: 1rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
.provenance summary { cursor: pointer; font-weight: 680; }
.provenance dl { margin-bottom: 0; }

.form-panel { max-width: 44rem; padding: 1.15rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .9rem 1rem; }
.field { min-width: 0; display: grid; gap: .35rem; }
.field-wide { grid-column: 1 / -1; }
.field label, .field-label { font-size: .84rem; font-weight: 680; }
.field-hint { color: var(--color-muted); font-size: .78rem; }
input, select, textarea { width: 100%; min-width: 0; padding: .58rem .68rem; color: var(--color-ink); background: var(--color-bg); border: 1px solid oklch(0.72 0.025 252); border-radius: var(--radius-sm); }
textarea { min-height: 6rem; resize: vertical; }
input::placeholder, textarea::placeholder { color: oklch(0.42 0.02 252); }
input:focus, select:focus, textarea:focus { border-color: var(--color-primary); }
input[aria-invalid="true"], select[aria-invalid="true"], textarea[aria-invalid="true"] { border-color: var(--color-danger); background: var(--color-danger-soft); }
.checkbox { display: flex; align-items: start; gap: .55rem; }
.checkbox input { width: 1.1rem; min-height: 1.1rem; margin-top: .18rem; }
.form-actions { display: flex; align-items: center; gap: .65rem; margin-top: 1rem; }
.form-result { min-height: 1.5rem; margin-top: .75rem; color: var(--color-muted); }
.form-result[data-status="error"] { color: var(--color-danger); }

.access-required { max-width: 45rem; margin: 10vh auto; padding: clamp(1rem, 4vw, 2rem); }
.access-required h1 { font-size: 2rem; letter-spacing: -.035em; }
.principal-code { display: block; max-width: 100%; padding: .8rem; border-radius: var(--radius-sm); background: var(--color-surface-strong); overflow-wrap: anywhere; }
.footer { max-width: var(--content-width); margin: 0 auto; padding: 1.5rem clamp(1rem, 3vw, 2rem) 2.5rem; border-top: 1px solid var(--color-border); display: flex; justify-content: flex-end; color: var(--color-muted); font-size: .82rem; }

@media (max-width: 760px) {
  .header-inner { align-items: flex-start; flex-wrap: wrap; }
  .primary-nav { order: 3; width: 100%; overflow-x: auto; flex-wrap: nowrap; padding-bottom: .15rem; }
  .primary-nav a { flex: 0 0 auto; }
  .layout { display: block; padding-top: 1.25rem; }
  .side-nav { position: static; display: flex; flex-wrap: wrap; overflow: visible; margin: 0 0 1.5rem; }
  .side-nav h2 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .side-nav a { flex: 0 0 auto; white-space: nowrap; }
  .page-header { align-items: flex-start; flex-direction: column; }
  .page-header h1 { font-size: 1.65rem; }
  .form-grid { grid-template-columns: minmax(0, 1fr); }
  .field-wide { grid-column: auto; }
  .detail-list { grid-template-columns: minmax(0, 1fr); }
  .detail-list dt { padding-bottom: .2rem; border-bottom: 0; }
  .detail-list dd { padding-top: 0; }
  .card-actions { align-items: flex-start; flex-direction: column; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
  .application-card:hover { transform: none; }
}
`;
