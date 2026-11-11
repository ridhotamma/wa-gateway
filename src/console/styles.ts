import { PROGRESS_CSS } from './progress.js'

const FONT_FACES = (
  [
    ['Light', 300, 'normal'],
    ['Regular', 400, 'normal'],
    ['Medium', 500, 'normal'],
    ['Bold', 700, 'normal'],
  ] as const
)
  .map(
    ([file, weight, style]) =>
      `@font-face{font-family:"Neue Montreal";src:url("/fonts/NeueMontreal-${file}.otf") format("opentype");font-weight:${weight};font-style:${style};font-display:swap}`,
  )
  .join('\n')

/**
 * Console stylesheet, kept as a string so the console has no build step.
 * Order: tokens, base, app frame, page structure, components, forms, phones.
 */
export const CONSOLE_CSS = `
${FONT_FACES}

/* Tokens */
:root{
  --bg:#f7f7f8;--surface:#fff;--surface-2:#fafafa;--hover:#f2f2f3;--active:#ececee;
  --text:#1c1c1e;--subdued:#6b6b70;--disabled:#b4b4b8;
  --border:#e6e6e9;--border-strong:#d2d2d6;
  --primary:#1c1c1e;--primary-hover:#000;
  --brand:#1f8a4c;--brand-bg:#e3f5ea;
  --critical:#b42318;--critical-bg:#fdecea;--success:#1f7a45;--success-bg:#e5f4eb;
  --attention:#8a4b00;--attention-bg:#fdf0dc;--info:#1d5c96;--info-bg:#e6f0fa;
  --focus:#1d5c96;--ring:0 0 0 3px rgba(29,92,150,.18);
  --radius:10px;--radius-lg:14px;
  --shadow-sm:0 1px 2px rgba(16,16,20,.04);
  --shadow-lg:0 16px 40px rgba(16,16,20,.16),0 2px 8px rgba(16,16,20,.06);
  --nav-w:232px;
}

/* Base */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
[hidden]{display:none!important}
body{font:14px/1.5 "Neue Montreal",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--focus);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3{font-weight:500;letter-spacing:-.01em}
code,.mono,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;letter-spacing:0}
.icon{display:inline-block;flex:none;vertical-align:-.15em}
.subdued{color:var(--subdued)}
.inline{display:inline}
.nowrap{white-space:nowrap}
.clip{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}

/* App frame: sidebar + content */
.frame{display:grid;grid-template-columns:var(--nav-w) minmax(0,1fr);min-height:100vh}
.nav{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;gap:2px;padding:0 10px;overflow:auto;background:var(--bg)}
/* Keep items at full size; a short window scrolls the sidebar instead of squeezing it. */
.nav>*{flex-shrink:0}
/* Sidebar scrollbar: thin and rounded, hidden until the sidebar is hovered or focused. The gutter is reserved so links never shift. */
.nav{overflow-x:hidden;overflow-y:auto;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:transparent transparent}
.nav:hover,.nav:focus-within{scrollbar-color:var(--border-strong) transparent}
.nav::-webkit-scrollbar{width:6px}
.nav::-webkit-scrollbar-track{background:transparent}
.nav::-webkit-scrollbar-thumb{border-radius:6px;background:transparent}
.nav:hover::-webkit-scrollbar-thumb,.nav:focus-within::-webkit-scrollbar-thumb{background:var(--border-strong)}
.nav::-webkit-scrollbar-thumb:hover{background:var(--subdued)}
/* The brand and the account row stay pinned; only the links between them scroll. */
.nav-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:14px 2px 12px;border-bottom:1px solid var(--border);background:var(--bg)}
.nav-brand{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:4px;border-radius:var(--radius);color:var(--text)}
.nav-brand:hover{text-decoration:none;background:var(--hover)}
.nav-brand-text{display:flex;flex-direction:column;min-width:0;line-height:1.2}
.nav-brand-text b{font-weight:500;font-size:14px}
.nav-brand-text span{color:var(--subdued);font-size:12px}
.nav-group{padding:14px 10px 4px;color:var(--subdued);font-size:11.5px;letter-spacing:.02em}
.nav-link{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;border-radius:8px;color:var(--subdued);font-weight:500}
.nav-link:hover{background:var(--hover);color:var(--text);text-decoration:none}
.nav-link.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm),inset 0 0 0 1px var(--border)}
.nav-link.on .icon{color:var(--brand)}
.nav-foot{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;margin-top:auto;padding:12px 4px;border-top:1px solid var(--border);background:var(--bg)}
.nav-admin{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--subdued);font-size:13px}
.nav-toggle{all:unset;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;color:var(--subdued);cursor:pointer}
.nav-toggle:hover{background:var(--hover);color:var(--text)}
.nav-toggle:focus-visible{outline:2px solid var(--focus)}
.nav-toggle span{display:flex}.nav-expand-icon{display:none!important}
.nav-tooltip{position:fixed;z-index:100;padding:5px 9px;border-radius:7px;background:var(--text);color:#fff;font-size:12px;font-weight:500;white-space:nowrap;pointer-events:none}
.topbar,#nav-toggle,.scrim{display:none}
.frame>main{min-width:0;border-left:1px solid var(--border)}
.page{max-width:1080px;margin:0 auto;padding:28px 32px 72px}
@media(min-width:769px){
  html.nav-collapsed{--nav-w:64px}
  html.nav-collapsed .nav-head{flex-direction:column;gap:8px}
  html.nav-collapsed .nav-brand{flex:none}
  html.nav-collapsed .nav-brand-text,html.nav-collapsed .nav-group,html.nav-collapsed .nav-link span,html.nav-collapsed .nav-admin{display:none}
  html.nav-collapsed .nav-link{justify-content:center;padding:0}
  html.nav-collapsed .nav-foot{flex-direction:column;padding:12px 0}
  html.nav-collapsed .nav-collapse-icon{display:none!important}
  html.nav-collapsed .nav-expand-icon{display:flex!important}
}

/* Page header */
.header{display:flex;align-items:flex-start;gap:12px;margin-bottom:24px}
.header .back{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;margin-top:-1px;border-radius:8px;color:var(--text);border:1px solid var(--border);background:var(--surface)}
.header .back:hover{background:var(--hover);text-decoration:none}
.header-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.header-title{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;min-width:0}
.header h1{margin:0;font-size:22px;line-height:30px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.header h1.mono{font-size:20px;letter-spacing:-.01em}
.header-sub{margin:0;color:var(--subdued);font-size:13.5px}
.header .actions{display:flex;align-items:center;gap:8px;flex:none}

/* Layout */
.narrow{max-width:760px}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start}
.col{display:flex;flex-direction:column;gap:20px;min-width:0}
.stack{display:flex;flex-direction:column;gap:20px}
.section{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px 32px;padding:24px 0;border-top:1px solid var(--border)}
.section:first-child,.header+.section{border-top:0;padding-top:0}
.section-aside h2{margin:0 0 4px;font-size:15px;line-height:22px}
.section-aside p{margin:0;color:var(--subdued);font-size:13px}
.section-aside .badge{margin-top:8px}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);padding:18px;min-width:0}
.card.flush{padding:0;overflow:hidden}
.card h2{margin:0;font-size:15px;line-height:22px}
.card-head{display:flex;align-items:center;gap:8px;min-height:28px;margin-bottom:14px}
.card.flush>.card-head{margin:0;padding:12px 18px;border-bottom:1px solid var(--border)}
.card-head-actions{display:flex;align-items:center;gap:8px;margin-left:auto}
.card .hint{margin:-8px 0 16px;color:var(--subdued);font-size:13px}
.card .foot{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.card.danger{border-color:color-mix(in srgb,var(--critical) 30%,var(--border))}

/* Stat strip: one surface split into equal cells */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin-bottom:20px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius-lg);overflow:hidden;box-shadow:var(--shadow-sm)}
.stat{display:flex;flex-direction:column;gap:2px;padding:14px 18px;background:var(--surface);color:var(--text);min-width:0}
a.stat:hover{background:var(--surface-2);text-decoration:none}
.stat-label{color:var(--subdued);font-size:12.5px}
.stat-value{font-size:24px;line-height:32px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stat-value.sm{font-size:15px;line-height:32px;letter-spacing:0}
.stat-sub{color:var(--subdued);font-size:12px}

/* Key/value list */
.list{list-style:none;margin:0;padding:0}
.list li{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:9px 0;border-top:1px solid var(--border);font-size:13.5px}
.list li:first-child{border-top:0;padding-top:0}.list li:last-child{padding-bottom:0}
.list li>:first-child{flex:none;color:var(--subdued)}
.list li>:last-child{min-width:0;text-align:right;overflow-wrap:anywhere}
.list li>.clip:last-child{overflow-wrap:normal}

/* Feed: activity rows */
.feed{list-style:none;margin:0;padding:0}
.feed li{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--border);min-width:0}
.feed li:first-child{border-top:0;padding-top:0}.feed li:last-child{padding-bottom:0}
.feed-main{flex:1;min-width:0}
.feed-main b{display:block;font-weight:500;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed-main span{display:block;color:var(--subdued);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.feed time{flex:none;color:var(--subdued);font-size:12px;line-height:20px}

/* Tables */
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{padding:9px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);color:var(--subdued);font-size:12px;font-weight:500;text-align:left;white-space:nowrap}
td{padding:11px 14px;border-bottom:1px solid var(--border);vertical-align:middle}
th:first-child,td:first-child{padding-left:18px}th:last-child,td:last-child{padding-right:18px}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--surface-2)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.actions{text-align:right;white-space:nowrap;width:1%}
td .badge+.badge{margin-left:6px}
.cell-title{font-weight:500;color:var(--text)}
.cell-sub{display:block;color:var(--subdued);font-size:12px;line-height:16px;margin-top:2px}
.row-actions{display:inline-flex;gap:6px;align-items:center;justify-content:flex-end}
.table-muted td{color:var(--subdued)}

/* Empty state */
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:40px 20px}
.empty-icon{display:flex;align-items:center;justify-content:center;width:40px;height:40px;margin-bottom:12px;border-radius:12px;background:var(--hover);color:var(--subdued)}
.empty h3{margin:0 0 4px;font-size:14.5px}
.empty p{max-width:360px;margin:0 0 16px;color:var(--subdued);font-size:13px}
.empty p:last-child{margin-bottom:0}

/* Buttons */
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:0 14px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-weight:500;font-size:13.5px;white-space:nowrap;cursor:pointer;box-shadow:var(--shadow-sm);transition:background .12s,border-color .12s}
button:hover,.btn:hover{background:var(--hover);text-decoration:none}
button:disabled{opacity:.5;cursor:not-allowed}
button.primary,.btn.primary{background:var(--primary);border-color:var(--primary);color:#fff}
button.primary:hover,.btn.primary:hover{background:var(--primary-hover)}
button.critical,.btn.critical{color:var(--critical)}
button.critical:hover{background:var(--critical-bg);border-color:color-mix(in srgb,var(--critical) 30%,var(--border-strong))}
button.destructive{background:var(--critical);border-color:var(--critical);color:#fff}
button.destructive:hover{background:#8f1c13}
button.small,.btn.small{min-height:28px;padding:0 10px;font-size:12.5px}
button.plain{min-height:0;padding:0 2px;border:0;background:none;box-shadow:none;color:var(--focus)}
.icon-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;color:var(--subdued);cursor:pointer;list-style:none}
.icon-btn::-webkit-details-marker{display:none}
.icon-btn:hover{background:var(--hover);color:var(--text)}
.icon-btn:focus-visible{outline:2px solid var(--focus)}
.id-copy{display:inline-flex;align-items:center;gap:2px;max-width:100%}.id-copy .mono{overflow:hidden;text-overflow:ellipsis}
.icon-btn.id-copy-btn{width:auto;min-width:24px;height:24px;padding:0 4px;gap:4px;font-size:12px}
.id-copy-btn [data-copy-label]:empty{display:none}

/* Badges */
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;background:var(--active);color:var(--subdued);font-size:12px;font-weight:500;white-space:nowrap}
.badge.success{background:var(--success-bg);color:var(--success)}
.badge.critical{background:var(--critical-bg);color:var(--critical)}
.badge.attention{background:var(--attention-bg);color:var(--attention)}
.badge.info{background:var(--info-bg);color:var(--info)}
.badge.dot::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}

/* Brand tile + avatar */
.tile{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:9px;background:var(--active);color:var(--text);font-weight:500;line-height:1}
.tile.sm{width:24px;height:24px;border-radius:7px}.tile.lg{width:40px;height:40px;border-radius:12px}
.tile.green{background:var(--brand);color:#fff}
.tile.blue{background:var(--info-bg);color:var(--info)}.tile.orange{background:var(--attention-bg);color:var(--attention)}
.avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:50%;background:var(--active);color:var(--text);font-size:11px;font-weight:500;line-height:1}
.avatar.md{width:32px;height:32px;font-size:12px}

/* Banners and toast */
.banner{display:flex;align-items:flex-start;gap:10px;margin-bottom:20px;padding:12px 14px;border-radius:var(--radius);background:var(--info-bg);color:var(--info);font-size:13.5px;transition:opacity .18s,transform .18s}
.banner.success{background:var(--success-bg);color:var(--success)}
.banner.critical{background:var(--critical-bg);color:var(--critical)}
.banner.warning{background:var(--attention-bg);color:var(--attention)}
.banner a{color:inherit;text-decoration:underline}
.banner-icon{display:flex;flex:none;margin-top:1px}
.banner-content{flex:1;min-width:0}
.banner-close{all:unset;display:flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;opacity:.7;cursor:pointer}
.banner-close:hover{opacity:1;background:rgba(0,0,0,.06)}
.banner-close:focus-visible{outline:2px solid currentColor;opacity:1}
.banner-out{opacity:0;transform:translateY(-4px)}
.toast{position:fixed;left:50%;bottom:24px;z-index:50;display:flex;align-items:center;gap:8px;max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:var(--text);color:#fff;font-weight:500;box-shadow:var(--shadow-lg);transform:translateX(-50%);animation:toast 4s forwards}
.toast .icon{color:#6fd39a}
@keyframes toast{0%{opacity:0;transform:translate(-50%,8px)}8%,85%{opacity:1;transform:translate(-50%,0)}100%{opacity:0;visibility:hidden}}

/* Forms */
label{display:block;margin-bottom:14px;font-size:13.5px;font-weight:500}
label>input,label>select,label>textarea{display:block;width:100%;margin-top:6px;font-weight:400}
label small,.help{display:block;margin-top:6px;color:var(--subdued);font-size:12.5px;font-weight:400}
input,select,textarea{min-height:36px;padding:7px 11px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font:inherit;font-size:14px;transition:border-color .12s,box-shadow .12s}
input::placeholder,textarea::placeholder{color:var(--disabled)}
input:hover,select:hover,textarea:hover{border-color:#bdbdc2}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--focus);box-shadow:var(--ring)}
input[readonly]{background:var(--surface-2)}
textarea{min-height:96px;resize:vertical}
input[type=checkbox],input[type=radio]{width:16px;height:16px;min-height:0;margin:0;padding:0;accent-color:var(--primary);box-shadow:none}
select:not([multiple]){appearance:none;-webkit-appearance:none;padding-right:34px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' fill='none'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' stroke='%236b6b70' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 8px}
label.check{display:flex;align-items:center;gap:10px;font-weight:500}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:0 14px}
.stack-fields{display:flex;flex-direction:column}
.inline-form{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}
.inline-form label{flex:1 1 220px;margin:0}
.copy-row{display:flex;gap:8px}.copy-row input{flex:1;min-width:0}
.form-block{padding:18px 0;border-top:1px solid var(--border)}
.form-block:first-child{padding-top:0;border-top:0}
.form-block-title{margin:0 0 12px;font-size:13px;font-weight:500;color:var(--subdued)}
.page-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:20px}
.page-foot.sticky{position:sticky;bottom:0;z-index:5;margin:0 -4px;padding:14px 4px;background:linear-gradient(to bottom,transparent,var(--bg) 35%)}

/* Segmented radio control */
.segmented{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;margin-top:6px;border-radius:10px;background:var(--active)}
.segmented label{margin:0;font-weight:500}
.segmented input{position:absolute;opacity:0;pointer-events:none}
.segmented span{display:flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:7px;color:var(--subdued);font-size:13px;cursor:pointer;white-space:nowrap}
.segmented span:hover{color:var(--text)}
.segmented input:checked+span{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 1px rgba(0,0,0,.04)}
.segmented input:focus-visible+span{outline:2px solid var(--focus);outline-offset:1px}
.field-label{display:block;font-size:13.5px;font-weight:500}
.field-group{margin-bottom:14px}

/* File drop zone: the file input covers the whole zone, so clicks and drops both land on it */
.dropzone{position:relative;display:flex;align-items:center;gap:14px;margin:6px 0 0;padding:16px;border:1px dashed var(--border-strong);border-radius:var(--radius);background:var(--surface-2);font-weight:400;cursor:pointer;transition:border-color .12s,background .12s}
.dropzone:hover,.dropzone.is-dragover{border-color:var(--focus);background:var(--info-bg)}
.dropzone:has(input:focus-visible){box-shadow:var(--ring);border-color:var(--focus)}
.dropzone.has-file{border-style:solid;background:var(--surface)}
.dropzone>input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.dropzone-icon{display:flex;align-items:center;justify-content:center;flex:none;width:40px;height:40px;border-radius:10px;background:var(--surface);border:1px solid var(--border);color:var(--subdued)}
.dropzone.has-file .dropzone-icon{background:var(--success-bg);border-color:transparent;color:var(--success)}
.dropzone-text{display:flex;flex-direction:column;min-width:0}
.dropzone-text b{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dropzone-text span{color:var(--subdued);font-size:12.5px}
.help.error{color:var(--critical)}

/* QR */
.qr{display:flex;justify-content:center;padding:6px 0 10px}
.qr img{width:260px;max-width:100%;height:auto;border-radius:12px;border:1px solid var(--border);background:#fff;padding:8px}
.steps{margin:0 0 4px;padding-left:18px;color:var(--subdued);font-size:13px}.steps li{margin:2px 0}

/* Dialog */
dialog{width:100%;max-width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 32px);padding:0;overflow:auto;border:0;border-radius:var(--radius-lg);background:var(--surface);color:var(--text);box-shadow:var(--shadow-lg);transition:opacity .15s,transform .15s}
dialog[open]{animation:dialog-in .18s cubic-bezier(.2,.8,.2,1)}
dialog.dialog-wide{max-width:min(560px,calc(100vw - 32px))}
dialog.dialog-closing{opacity:0;transform:translateY(6px) scale(.98)}
dialog::backdrop{background:rgba(16,16,20,.4)}
@keyframes dialog-in{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}
.dialog-body{padding:22px}
.dialog h2{margin:0 0 6px;font-size:16px;line-height:24px}
.dialog-message{margin:0;color:var(--subdued)}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}

/* Menus and tabs (shared helpers) */
.menu-root{position:relative;display:inline-block}.menu-root>summary{list-style:none}
.menu{position:absolute;right:0;top:calc(100% + 4px);z-index:60;min-width:180px;padding:6px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);box-shadow:var(--shadow-lg)}
.menu-item{display:flex;align-items:center;gap:10px;min-height:32px;padding:6px 8px;border-radius:6px;color:var(--text)}
.menu-item:hover{background:var(--hover);text-decoration:none}
.tabs{display:flex;gap:4px;margin-bottom:20px;overflow-x:auto}
.tabs a{flex:none;padding:6px 12px;border-radius:8px;color:var(--subdued);font-weight:500}
.tabs a:hover{background:var(--hover);text-decoration:none}.tabs a.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm),inset 0 0 0 1px var(--border)}

/* Sign-in pages */
.auth{display:flex;flex-direction:column;justify-content:center;min-height:100vh;max-width:400px;margin:0 auto;padding:32px 16px}
.auth-brand{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px;font-size:16px;font-weight:500}
.auth .card{padding:24px}
.auth .card h2{font-size:18px;line-height:26px;margin-bottom:4px}
.auth .card .hint{margin:0 0 20px}
.auth .foot button{width:100%}
.auth-note{margin:16px 0 0;color:var(--subdued);font-size:12.5px;text-align:center}

/* Medium screens: single column content */
@media(max-width:1024px){
  .grid{grid-template-columns:minmax(0,1fr)}
  .section{grid-template-columns:minmax(0,1fr);gap:14px}
}

/* Phones: top bar + slide-in sidebar, stacked tables */
@media(max-width:768px){
  .frame{grid-template-columns:minmax(0,1fr)}
  .frame>main{border-left:0}
  .topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;height:54px;padding:0 12px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
  .topbar-menu{display:flex;align-items:center;justify-content:center;width:36px;height:36px;margin:0;border-radius:8px;cursor:pointer}
  .topbar-menu:hover{background:var(--hover)}
  .topbar-brand{display:flex;align-items:center;gap:8px;color:var(--text);font-weight:500}
  .topbar-brand:hover{text-decoration:none}
  .nav{position:fixed;inset:0 auto 0 0;z-index:30;width:272px;background:var(--surface);box-shadow:var(--shadow-lg);transform:translateX(-100%);transition:transform .22s ease;visibility:hidden}
  .nav-head,.nav-foot{background:var(--surface)}
  #nav-toggle:checked~.frame .nav{transform:none;visibility:visible}
  #nav-toggle:checked~.scrim{display:block;position:fixed;inset:0;z-index:25;background:rgba(16,16,20,.35)}
  .nav-toggle{display:none}
  .nav-link{height:40px}
  .page{padding:20px 16px 56px}
  .header{flex-wrap:wrap;margin-bottom:20px}
  .header h1{font-size:20px;line-height:28px}
  .header .actions{flex:1 1 100%}
  .header .actions>*{flex:1}
  .header:has(.back) .actions{flex:none}
  .header:has(.back) .actions>*{flex:none}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stat{padding:12px 14px}
  .stat-value{font-size:20px;line-height:28px}
  .stat-value.sm{font-size:14px;line-height:28px}
  .card{padding:16px}
  .card.flush>.card-head{padding:12px 16px}
  .grid,.col,.stack{gap:16px}
  input:not([type=checkbox]):not([type=radio]),select,textarea{font-size:16px}
  table.stacked thead{display:none}
  table.stacked,table.stacked tbody,table.stacked tr,table.stacked td{display:block;width:auto}
  table.stacked tr{padding:12px 16px;border-bottom:1px solid var(--border)}
  table.stacked tbody tr:last-child{border-bottom:0}
  table.stacked tbody tr:hover td{background:none}
  table.stacked td{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:3px 0!important;border:0;text-align:right}
  table.stacked td[data-label]::before{content:attr(data-label);flex:none;color:var(--subdued);font:400 12.5px/1.5 "Neue Montreal",-apple-system,sans-serif;text-align:left}
  table.stacked td:first-child{display:block;padding-bottom:6px!important;text-align:left}
  table.stacked td.actions{width:auto;justify-content:flex-end;padding-top:10px!important}
  table.stacked td.actions:empty{display:none}
  .page-foot{flex-direction:column-reverse}.page-foot>*{width:100%}
  .dialog-actions{flex-direction:column-reverse}.dialog-actions>*{width:100%}
  .inline-form>button{width:100%}
  .segmented{display:flex}.segmented label{flex:1}.segmented span{justify-content:center}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
${PROGRESS_CSS}`
