// ==UserScript==
// @name         Palomar SDR — Custom UI
// @namespace    https://palomar-sdr.com/
// @version      0.8.4
// @description  KiwiSDR-style overlay UI for palomar-sdr.com/radio.html
// @author       WA2N / WA2ZKD
// @match        https://palomar-sdr.com/radio.html
// @match        http://palomar-sdr.com/radio.html
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════
// SOURCE CANVAS
// spectrum.js renders everything into #waterfall:
//   top spectrumPercent%  → spectrum trace + axes
//   remainder             → waterfall rows
//
// We drawImage() the right slices into our own overlay canvases.
// Raw FFT data is available from window.spectrum.bin_copy.
// ═══════════════════════════════════════════════════════════════════
let _src = null;      // set once #waterfall has real dimensions
let _srcReady = false;

function findSourceCanvas() {
    const c = document.getElementById('waterfall');
    if (c && c.width > 0 && c.height > 0) { _src = c; _srcReady = true; return true; }
    return false;
}

// ── Hide original UI ──────────────────────────────────────────────
// Use opacity:0 so the source canvas still composites and drawImage()
// can read it. visibility:hidden can prevent GPU-composited readback.
// Explicit IDs for OUR canvases are exempted so they stay visible.
const hideCSS = document.createElement('style');
hideCSS.textContent = `
  html, body {
    overflow: hidden !important;
  }
  body > *:not(#p-overlay) {
    opacity: 0 !important;
    pointer-events: none !important;
  }
  /* Keep source canvas rendered in-place — moving it off-screen stops
     the browser from painting it, making drawImage() read black pixels.
     Our overlay sits on top via z-index so #waterfall is never seen. */
  canvas#waterfall {
    opacity: 0 !important;
    pointer-events: none !important;
  }
  /* Our overlay canvases must stay fully visible */
  canvas#p-sp, canvas#p-wf, canvas#p-sc {
    opacity: 1 !important;
    position: static !important;
    visibility: visible !important;
    pointer-events: all !important;
  }
`;
document.head.appendChild(hideCSS);

// ── Overlay HTML ──────────────────────────────────────────────────
const OV = document.createElement('div');
OV.id = 'p-overlay';
OV.innerHTML = `
<style>
#p-overlay,#p-overlay *{box-sizing:border-box;margin:0;padding:0}
#p-overlay{
  position:fixed;top:0;left:0;width:100%;height:100%;
  z-index:2147483647;display:flex;flex-direction:column;
  font-family:"DejaVu Sans",Verdana,Geneva,sans-serif;
  font-size:13px;background:#000;color:#fff;overflow:hidden;
}
#p-tbar{
  flex-shrink:0;height:48px;background:#ececec;
  display:flex;align-items:center;padding:0 8px;gap:10px;
  overflow:hidden;transition:height .15s;
}
#p-tbar.closed{height:0}
#p-title{font-size:11pt;font-weight:bold;color:#909090;white-space:nowrap}
#p-desc{font-size:9pt;color:#909090;white-space:nowrap}
#p-ident{font-size:85%;color:#909090;margin-left:auto;white-space:nowrap}
#p-tbar-arr{cursor:pointer;color:#909090;padding:0 6px;user-select:none;flex-shrink:0;font-size:16px}
#p-tbar-arr:hover{color:#555}
#p-rf{flex:1;position:relative;min-height:0;display:flex;flex-direction:column}
#p-sp-wrap{height:140px;flex-shrink:0;background:#000;position:relative;cursor:crosshair}
#p-sp{display:block;width:100%;height:100%}
#p-sp-db{
  position:absolute;top:0;left:2px;bottom:14px;
  display:flex;flex-direction:column;justify-content:space-between;
  pointer-events:none;font:8px inherit;color:#3a3a3a;
}
#p-tune-wrap{position:relative;flex-shrink:0}
#p-dx-bar{height:18px;background:#f5f5f5;border-bottom:1px solid #ccc;position:relative;overflow:hidden}
#p-tunelbl{position:absolute;top:1px;font-size:10px;font-weight:bold;color:#000;white-space:nowrap;pointer-events:none;z-index:4;transform:translateX(-50%)}
#p-sc-wrap{height:30px;position:relative;background:linear-gradient(to bottom,#c8c8c8,#e8e8e8,#c8c8c8)}
#p-sc{display:block;width:100%;height:100%}
.p-pb-cf{position:absolute;top:0;height:100%;background:rgba(255,255,0,.18);z-index:1}
.p-pb-cut{position:absolute;top:0;height:100%;width:5px;background:rgba(255,200,0,.5);z-index:2}
.p-pb-car{position:absolute;top:0;height:100%;width:2px;background:rgba(255,255,0,.9);z-index:3}
#p-wf-wrap{flex:1;position:relative;min-height:0;background:#1e5f7f;overflow:hidden;cursor:crosshair}
#p-wf{display:block;width:100%;height:100%;pointer-events:none}
#p-tip{
  position:absolute;display:none;pointer-events:none;
  background:#333;border:1px solid #666;color:#e8c000;
  font-size:10px;padding:1px 5px;z-index:5;top:4px;
}
.p-dxl{position:absolute;width:1px;background:#000;top:0;bottom:0}
.p-dxt{position:absolute;font-size:10px;padding:1px 3px;border:1px solid #000;
  border-radius:3px;background:rgba(255,255,220,.85);color:#000;white-space:nowrap;top:1px}
#p-panel{
  position:fixed;right:0;top:48px;bottom:0;
  display:flex;flex-direction:row;
  background:#575757;color:#fff;font-size:85%;
  border-radius:15px 0 0 15px;overflow:visible;
  z-index:2147483647;transition:top .15s;
}
#p-panel.fullh{top:0}
#p-panel.collapsed{background:transparent}
#p-panel.collapsed #p-inner{width:0;padding:0;overflow:hidden}
#p-vis{
  position:absolute;left:-28px;top:calc(50% - 24px);
  width:28px;height:48px;background:#575757;border-radius:5px 0 0 5px;
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  font-size:14px;color:#ccc;user-select:none;
}
#p-vis:hover{background:#666;color:#fff}
#p-inner{
  width:290px;overflow-y:auto;overflow-x:hidden;
  display:flex;flex-direction:column;gap:5px;
  padding:10px 8px 10px 10px;
  scrollbar-width:thin;scrollbar-color:#777 #575757;
}
#p-inner::-webkit-scrollbar{width:5px}
#p-inner::-webkit-scrollbar-thumb{background:#888}
#p-fdisp{background:#000;border-radius:4px;padding:5px 8px;display:flex;align-items:baseline;justify-content:center;gap:4px;flex-shrink:0}
#p-fnum{font:bold 30px/1 Consolas,monospace;color:#e8c000;letter-spacing:.02em;
  background:transparent;border:none;outline:none;text-align:right;width:100%;cursor:pointer;padding:0}
#p-fnum:focus{cursor:text;color:#fff}
#p-fnum:read-only{color:#e8c000}
#p-funit{font-size:12px;font-weight:bold;line-height:1;color:#a08000;flex-shrink:0}
.p-hr{border:none;border-top:3px solid #aaa;margin:4px 0}
.p-s{font-size:80%;font-weight:bold;color:#ccc;margin-bottom:2px}
.cb{
  display:inline-block;background:#373737;padding:3px 6px;border-radius:6px;
  color:#fff;font-weight:bold;cursor:pointer;user-select:none;
  border:none;outline:none;white-space:nowrap;font-size:inherit;
}
.cb:hover{background:#474747}.cb:active{background:#777}
.cb.sel{background:#4CAF50!important;color:#fff}
.wb{
  display:inline-block;background:hsl(0,0%,92%);color:#000;
  padding:3px 6px;border-radius:6px;font-weight:bold;cursor:pointer;
  user-select:none;border:none;outline:none;white-space:nowrap;font-size:inherit;
}
.wb:hover{background:hsl(0,0%,82%)}
.wb.sel{background:#4CAF50!important;color:#fff}
.br{display:flex;gap:3px;flex-wrap:wrap;align-items:center}
.br .cb,.br .wb{flex:1;text-align:center}
select.ps{
  background:#444;border:1px solid #888;color:#fff;
  font:inherit;padding:3px 4px;cursor:pointer;outline:none;
  width:100%;border-radius:3px;
}
#p-sm{
  border:4px solid gray;border-width:4px 5px;border-radius:5px;
  height:20px;position:relative;overflow:hidden;
  background:linear-gradient(90deg,#115511,#44aa44 38%,#aacc00 62%,#ddaa00 76%,#cc4400 87%,#990000);
}
#p-smf{position:absolute;right:0;top:0;bottom:0;background:#575757;transition:width .06s;width:65%}
.p-sms{display:flex;justify-content:space-between;padding:0 2px;margin-top:1px}
.p-sms span{font-size:8px;color:#ccc}
#p-smv{font-size:10px;color:#aaa;text-align:right;margin-top:1px}
.p-sl{display:flex;align-items:center;gap:5px;white-space:nowrap}
.p-sll{font-size:85%;color:#ccc;width:50px;flex-shrink:0}
.p-slv{font-size:9px;color:#aaa;width:28px;text-align:right;flex-shrink:0}
input[type=range]{-webkit-appearance:none;height:22px;background:transparent;cursor:pointer;flex:1;min-width:0;outline:none}
input[type=range]::-webkit-slider-runnable-track{height:3px;background:#808080;border-radius:1px}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#fff;border:1px solid #808080;cursor:pointer;margin-top:-7px}
input[type=range]::-moz-range-track{height:3px;background:#808080;border-radius:1px}
input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#fff;border:1px solid #808080}
#p-dg-hdr{display:flex;align-items:center;justify-content:space-between;cursor:pointer;padding:4px 2px;border-top:3px solid #aaa;user-select:none;margin-top:2px}
#p-dg-body{display:none;margin-top:3px}
#p-dg-grid{display:grid;grid-template-columns:auto 1fr;gap:1px 8px;background:#3a3a3a;border-radius:5px;padding:6px 8px;font-size:11px;line-height:1.6}
#p-dg-solar{margin-top:5px;padding:4px 8px;background:#3a3a3a;border-radius:5px;font-size:10px;line-height:1.4;color:#dd0}
#p-stat{flex-shrink:0;padding-top:5px;border-top:1px solid #888;margin-top:4px;font-size:80%;color:#bbb}
#p-clk{font-size:11px;color:#aaa}
#p-badge{display:inline-block;background:#3a1500;border:1px solid #8a4500;color:#dd8800;font-size:9px;padding:1px 5px;border-radius:3px;margin-top:3px}
</style>

<div id="p-tbar">
  <div style="display:flex;flex-direction:column">
    <div id="p-title">Palomar SDR</div>
    <div id="p-desc">palomar-sdr.com · 0–30 MHz · WA2N / WA2ZKD</div>
  </div>
  <div id="p-ident">00:00:00 UTC</div>
  <div id="p-tbar-arr">▲</div>
</div>

<div id="p-rf">
  <div id="p-sp-wrap"><div id="p-sp-db"></div><canvas id="p-sp"></canvas></div>
  <div id="p-tune-wrap">
    <span id="p-tunelbl"></span>
    <div id="p-dx-bar"></div>
    <div id="p-sc-wrap">
      <canvas id="p-sc"></canvas>
      <div class="p-pb-cut" id="p-pb-lo"></div>
      <div class="p-pb-cut" id="p-pb-hi"></div>
      <div class="p-pb-cf"  id="p-pb-cf"></div>
      <div class="p-pb-car" id="p-pb-car"></div>
    </div>
  </div>
  <div id="p-wf-wrap"><canvas id="p-wf"></canvas><div id="p-tip"></div></div>
</div>

<div id="p-panel">
  <div id="p-vis">◀</div>
  <div id="p-inner">
    <div id="p-fdisp"><input id="p-fnum" value="—" readonly><span id="p-funit">kHz</span></div>

    <div class="br">
      <button class="cb" id="p-dn" style="flex:0;padding:4px 8px">&lt;</button>
      <button class="cb" id="p-up" style="flex:0;padding:4px 8px">&gt;</button>
      <select class="ps" id="p-step" style="flex:1">
        <option>1 Hz</option><option>10 Hz</option><option>100 Hz</option>
        <option>500 Hz</option><option selected>1 kHz</option>
        <option>5 kHz</option><option>10 kHz</option>
        <option>100 kHz</option><option>1 MHz</option>
      </select>
    </div>

    <hr class="p-hr">
    <div class="p-s">Mode</div>
    <div class="br" id="p-modes">
      <button class="wb" data-mode="am">AM</button>
      <button class="wb" data-mode="sam">SAM</button>
      <button class="wb" data-mode="lsb">LSB</button>
      <button class="wb" data-mode="usb">USB</button>
    </div>
    <div class="br" style="margin-top:3px">
      <button class="wb" data-mode="cwu">CWU</button>
      <button class="wb" data-mode="cwl">CWL</button>
      <button class="wb" data-mode="fm">FM</button>
      <button class="wb" data-mode="iq">IQ</button>
    </div>

    <hr class="p-hr">
    <div class="p-s">Zoom / Pan</div>
    <div class="br">
      <button class="cb" id="p-zo">Z −</button>
      <button class="cb" id="p-zi">Z +</button>
      <button class="cb" id="p-pl">◀</button>
      <button class="cb" id="p-pr">▶</button>
      <button class="cb" id="p-ctr">Ctr</button>
    </div>

    <hr class="p-hr">
    <div class="p-s">Signal</div>
    <div id="p-sm"><div id="p-smf"></div></div>
    <div class="p-sms"><span>1</span><span>3</span><span>5</span><span>7</span><span>9</span><span>+20</span><span>+40</span></div>
    <div id="p-smv">S— · — dBm</div>

    <hr class="p-hr">
    <div class="p-s">Audio</div>
    <div class="br">
      <button class="wb sel" id="p-aud">▶ Audio</button>
      <button class="cb" style="color:#ff8080">⏺ Rec</button>
    </div>
    <div class="p-sl" style="margin-top:3px">
      <span class="p-sll">Volume</span>
      <input type="range" id="p-vol" min="0" max="100" value="70">
      <span class="p-slv" id="p-volv">70</span>
    </div>

    <hr class="p-hr">
    <div class="p-s">Display</div>
    <div class="p-sl"><span class="p-sll">WF max</span><input type="range" id="p-wfmax" min="-160" max="0" value="-30"><span class="p-slv" id="p-wfmaxv">-30</span></div>
    <div class="p-sl"><span class="p-sll">WF min</span><input type="range" id="p-wfmin" min="-160" max="0" value="-120"><span class="p-slv" id="p-wfminv">-120</span></div>
    <div class="p-sl"><span class="p-sll">Sp max</span><input type="range" id="p-spmax" min="-160" max="0" value="-30"><span class="p-slv" id="p-spmaxv">-30</span></div>
    <div class="p-sl"><span class="p-sll">Sp min</span><input type="range" id="p-spmin" min="-160" max="0" value="-130"><span class="p-slv" id="p-spminv">-130</span></div>
    <div class="br" style="margin-top:3px">
      <button class="cb">COL</button>
      <button class="cb">Auto</button>
      <button class="wb sel" id="p-run">▶ Run</button>
    </div>

    <hr class="p-hr">
    <div class="p-s">Options</div>
    <div class="br"><button class="cb">DX labels</button><button class="cb">Memories</button></div>
    <div class="br" style="margin-top:3px"><button class="cb">Ext ▼</button><button class="cb">Help</button></div>

    <div style="flex:1;min-height:8px"></div>

    <div id="p-dg-hdr">
      <span style="font-size:80%;font-weight:bold;color:#ccc" id="p-dg-title">▸ RADIO STATUS</span>
      <span style="font-size:10px;color:#999" id="p-dg-arr">show</span>
    </div>
    <div id="p-dg-body">
      <div id="p-dg-grid"></div>
      <div id="p-dg-solar"></div>
    </div>

    <div id="p-stat">
      <div id="p-clk">00:00:00 UTC</div>
      <div id="p-badge">connecting…</div>
      <div style="margin-top:3px;font-size:80%;color:#888">Palomar SDR · WA2N / WA2ZKD</div>
    </div>
  </div>
</div>
`;
document.body.appendChild(OV);

// ── Canvas setup ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const wfC = $('p-wf'),  wfCtx = wfC.getContext('2d');
const spC = $('p-sp'),  spCtx = spC.getContext('2d');
const scC = $('p-sc'),  scCtx = scC.getContext('2d');

// ── State ─────────────────────────────────────────────────────────
let tuneKhz = 14225, centerKhz = 15000, spanKhz = 20000;
let sc = -30, sf = -130;
let paused = false, curMode = 'usb', diagOpen = false, smT = 0.35;
let maxH = null;
const ZOOMS = [30000,20000,15000,10000,5000,2000,1000,500,200,100];
const PB = {usb:[0,2.8],lsb:[-2.8,0],am:[-4,4],sam:[-4,4],cwu:[0,.5],cwl:[-.5,0],fm:[-6,6],iq:[-5,5]};

// ── Sync from radio.js ────────────────────────────────────────────
function syncFromRadio() {
    if (typeof window.frequencyHz !== 'undefined') {
        tuneKhz   = window.frequencyHz / 1000;
        centerKhz = window.centerHz   / 1000;
        // spanHz is declared with `let` in radio.js so it is NOT on `window`.
        // Read from the spectrum object which is kept in sync via setSpanHz().
        spanKhz   = (window.spectrum ? window.spectrum.spanHz : 0) / 1000;
        // Sync mode from the original page's mode selector
        const modeEl = document.getElementById('mode');
        if (modeEl && modeEl.value) {
            curMode = modeEl.value.toLowerCase();
            document.querySelectorAll('#p-inner [data-mode]').forEach(b=>b.classList.remove('sel'));
            const sel = document.querySelector('#p-inner [data-mode="'+curMode+'"]');
            if (sel) sel.classList.add('sel');
        }
        updateFDisp();
        $('p-badge').textContent = 'live — connected';
        $('p-badge').style.cssText = 'display:inline-block;background:#003a00;border:1px solid #007000;color:#44cc44;font-size:9px;padding:1px 5px;border-radius:3px;margin-top:3px';
    } else {
        setTimeout(syncFromRadio, 500);
    }
}
syncFromRadio();

// ── Resize ────────────────────────────────────────────────────────
function resize() {
    [spC, wfC, scC].forEach(c => {
        const W = c.parentElement.clientWidth, H = c.parentElement.clientHeight;
        if (c.width !== W || c.height !== H) {
            c.width = W; c.height = H;
            if (c === spC) maxH = null;
        }
    });
    buildDX(); drawScale(); buildDbLabels(); updatePB();
}

// ══════════════════════════════════════════════════════════════════
// RENDER
//
// spectrum.js draws into _src (#waterfall):
//   top spectrumHeight px → spectrum trace + axes
//   remaining px          → waterfall rows
//
// We must wait until:
//   1. _src exists and has real dimensions
//   2. window.spectrum is constructed
//   3. window.spectrum.spectrumHeight > 0  (set by updateSpectrumRatio,
//      which fires once the canvas has clientWidth/clientHeight — i.e.
//      after init() finishes inside the optionsDialog fetch callback)
// ══════════════════════════════════════════════════════════════════
function renderFromSource() {
    if (!_srcReady) return;

    const sp = window.spectrum;

    // Guard: spectrum object must be live and have a measured spectrumHeight
    if (!sp || !(sp.spectrumHeight > 0)) return;

    const specH   = sp.spectrumHeight;
    const srcW    = _src.width;
    const srcH    = _src.height;
    const wfSrcH  = srcH - specH;

    if (srcW <= 0 || srcH <= 0) return;

    // ── Waterfall: copy the bottom portion of the source canvas ──
    if (wfC.width > 0 && wfC.height > 0 && wfSrcH > 0) {
        wfCtx.drawImage(_src,
            0, specH, srcW, wfSrcH,      // source: waterfall region
            0, 0,     wfC.width, wfC.height  // dest:   our full wf canvas
        );
        drawTuneLine(wfCtx, wfC.width, wfC.height);
    }

    // ── Spectrum: prefer bin_copy for our custom trace style ──────
    if (spC.width > 0 && spC.height > 0) {
        const bins = (sp.bin_copy && sp.bin_copy.length > 0) ? sp.bin_copy : null;
        drawSpec(bins);
    }
}

// ── Spectrum trace ────────────────────────────────────────────────
function drawSpec(bins) {
    const W = spC.width, H = spC.height;
    const dR = sc - sf;
    spCtx.fillStyle = '#000'; spCtx.fillRect(0, 0, W, H);

    // Horizontal dB grid lines
    spCtx.strokeStyle = 'rgba(255,255,255,.04)'; spCtx.lineWidth = 1;
    for (let db = Math.ceil(sf/10)*10; db <= sc; db += 10) {
        const y = H - ((db-sf)/dR)*H;
        spCtx.beginPath(); spCtx.moveTo(0,y); spCtx.lineTo(W,y); spCtx.stroke();
    }

    if (!bins) { drawTuneLine(spCtx, W, H); return; }

    const n = bins.length;
    if (!maxH || maxH.length !== W) maxH = new Float32Array(W).fill(sf);

    // Map bins → pixel columns
    const pts = new Float32Array(W);
    for (let x = 0; x < W; x++) {
        const b = Math.min(n-1, Math.floor((x/W)*n));
        pts[x] = bins[b];
    }

    // Decay max-hold
    for (let x = 0; x < W; x++) {
        if (pts[x] > maxH[x]) maxH[x] = pts[x];
        else maxH[x] = maxH[x]*.997 + pts[x]*.003;
    }

    // Max-hold trace (dim orange-red)
    spCtx.beginPath(); spCtx.strokeStyle = 'rgba(180,80,50,.4)'; spCtx.lineWidth = 1;
    for (let x = 0; x < W; x++) {
        const y = H - Math.max(0, Math.min(H, ((maxH[x]-sf)/dR)*H));
        x === 0 ? spCtx.moveTo(x,y) : spCtx.lineTo(x,y);
    } spCtx.stroke();

    // Filled area + live trace
    spCtx.beginPath(); spCtx.moveTo(0, H);
    for (let x = 0; x < W; x++) spCtx.lineTo(x, H - Math.max(0, Math.min(H, ((pts[x]-sf)/dR)*H)));
    spCtx.lineTo(W, H); spCtx.closePath();
    const g = spCtx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'rgba(70,170,70,.72)'); g.addColorStop(.5,'rgba(35,95,35,.25)'); g.addColorStop(1,'rgba(0,0,0,0)');
    spCtx.fillStyle = g; spCtx.fill();
    spCtx.beginPath(); spCtx.strokeStyle = '#55bb55'; spCtx.lineWidth = 1.2;
    for (let x = 0; x < W; x++) {
        const y = H - Math.max(0, Math.min(H, ((pts[x]-sf)/dR)*H));
        x === 0 ? spCtx.moveTo(x,y) : spCtx.lineTo(x,y);
    } spCtx.stroke();

    drawTuneLine(spCtx, W, H);
}

function drawTuneLine(ctx, W, H) {
    const x = Math.round(((tuneKhz - (centerKhz - spanKhz/2)) / spanKhz) * W);
    ctx.save();
    ctx.strokeStyle = 'rgba(200,180,0,.7)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
}

// ── Frequency scale ───────────────────────────────────────────────
function drawScale() {
    const W = scC.width, H = scC.height; if (!W) return;
    const g = scCtx.createLinearGradient(0,0,0,H);
    g.addColorStop(0,'#c8c8c8'); g.addColorStop(.5,'#e8e8e8'); g.addColorStop(1,'#c8c8c8');
    scCtx.fillStyle = g; scCtx.fillRect(0,0,W,H);
    const lo = (centerKhz-spanKhz/2)/1000, hi = (centerKhz+spanKhz/2)/1000, range = hi-lo;
    const steps = [.001,.002,.005,.01,.02,.05,.1,.2,.5,1,2,5,10,15,20];
    let step = 1; for (const s of steps) { if (range/s <= 14) { step=s; break; } }
    scCtx.font = '9px "DejaVu Sans",Verdana,Geneva,sans-serif'; scCtx.textAlign = 'center';
    for (let f = Math.ceil(lo/step)*step; f <= hi+step*.001; f += step) {
        const x = ((f-lo)/range)*W;
        scCtx.strokeStyle = 'rgba(0,0,0,.15)'; scCtx.lineWidth = 1;
        scCtx.beginPath(); scCtx.moveTo(x,0); scCtx.lineTo(x,H); scCtx.stroke();
        scCtx.fillStyle = '#444';
        scCtx.fillText(step<1?(f*1000).toFixed(0):f.toFixed(step<.1?2:step<1?1:0), x, H-2);
    }
    updateTuneLabel();
}
function updateTuneLabel() {
    const W = $('p-dx-bar').clientWidth; if (!W) return;
    const lo = centerKhz-spanKhz/2, x = ((tuneKhz-lo)/spanKhz)*W;
    const lbl = $('p-tunelbl');
    lbl.textContent = (tuneKhz/1000).toFixed(3)+' MHz';
    lbl.style.left = x+'px';
}

function updatePB() {
    const W = scC.width; if (!W) return;
    const pb = PB[curMode]||[0,2.8], lo = centerKhz-spanKhz/2, H = $('p-sc-wrap').clientHeight;
    const car = Math.round(((tuneKhz-lo)/spanKhz)*W);
    const x0  = Math.round(((tuneKhz+pb[0]-lo)/spanKhz)*W);
    const x1  = Math.round(((tuneKhz+pb[1]-lo)/spanKhz)*W);
    $('p-pb-lo').style.cssText = `left:${x0-2}px;height:${H}px`;
    $('p-pb-hi').style.cssText = `left:${x1-2}px;height:${H}px`;
    $('p-pb-cf').style.cssText = `left:${x0}px;width:${Math.max(0,x1-x0)}px;height:${H}px`;
    $('p-pb-car').style.cssText = `left:${car-1}px;height:${H}px`;
}

function buildDbLabels() {
    const H = spC.height; if (!H) return;
    const el = $('p-sp-db'), dR = sc-sf; el.innerHTML = '';
    for (let db = Math.ceil(sf/20)*20; db <= sc; db += 20) {
        const s = document.createElement('span');
        s.textContent = db;
        s.style.cssText = `position:absolute;top:${Math.round(H-((db-sf)/dR)*H-6)}px`;
        el.appendChild(s);
    }
}

const DX=[
    {f:5000,l:'WWV'},{f:10000,l:'WWV'},{f:15000,l:'WWV'},
    {f:7074,l:'FT8'},{f:14074,l:'FT8'},{f:21074,l:'FT8'},
    {f:14100,l:'WSPR'},{f:14225,l:'SSB'},{f:9975,l:'CHU'},
    {f:7200,l:'AM'},{f:9500,l:'SW'},
];
function buildDX() {
    const bar = $('p-dx-bar'); bar.innerHTML = '';
    const W = bar.clientWidth, lo = centerKhz-spanKhz/2;
    for (const {f,l} of DX) {
        const x = ((f-lo)/spanKhz)*W; if (x<2||x>W-2) continue;
        const ln = document.createElement('div'); ln.className='p-dxl'; ln.style.left=x+'px'; bar.appendChild(ln);
        const lb = document.createElement('div'); lb.className='p-dxt'; lb.style.left=(x+2)+'px'; lb.textContent=l; bar.appendChild(lb);
    }
}

// ── S-meter ───────────────────────────────────────────────────────
// Read baseband power directly from radio.js if available, otherwise simulate
function tickSM() {
    const pwr = (typeof window.power !== 'undefined') ? window.power : null;
    if (pwr !== null && isFinite(pwr)) {
        // power is already in dBm (radio.js: power = 10*log10(power))
        const dBm = pwr;
        // Map roughly -120 dBm → 0, -40 dBm → 1
        smT = Math.max(0, Math.min(1, (dBm + 120) / 80));
    } else {
        smT += (Math.random()-.5)*.05;
        smT = Math.max(.02, Math.min(.97, smT));
    }
    $('p-smf').style.width = ((1-smT)*100)+'%';
    const sv = Math.max(1, Math.min(9, Math.ceil(smT*9)));
    $('p-smv').textContent = `S${sv}  ${Math.round(-120+smT*80)} dBm`;
}

// ── Clock ─────────────────────────────────────────────────────────
function updateClock() {
    const n = new Date(), p = v => String(v).padStart(2,'0');
    const s = `${p(n.getUTCHours())}:${p(n.getUTCMinutes())}:${p(n.getUTCSeconds())} UTC`;
    $('p-clk').textContent = s; $('p-ident').textContent = s;
}

function updateFDisp() {
    if(document.activeElement !== $('p-fnum')) $('p-fnum').value = tuneKhz.toFixed(3);
    drawScale(); updatePB();
}

// ── Main loop ─────────────────────────────────────────────────────
// Poll until the source canvas and spectrum object are ready before
// starting rAF. This handles the async optionsDialog.html fetch in radio.js.
let loopStarted = false;
let frame = 0;

function waitForReady() {
    // Step 1: find the source canvas once it has real dimensions
    if (!_srcReady) {
        findSourceCanvas();
        setTimeout(waitForReady, 100);
        return;
    }
    // Step 2: wait for window.spectrum to be constructed and fully sized
    const sp = window.spectrum;
    if (!sp || !(sp.spectrumHeight > 0)) {
        setTimeout(waitForReady, 100);
        return;
    }
    // Ready — start the render loop
    if (!loopStarted) {
        loopStarted = true;
        console.log('[Palomar] source canvas ready, spectrumHeight =', sp.spectrumHeight, '— starting loop');
        // Sync slider values from spectrum object
        if (typeof sp.wf_max_db==='number'){ $('p-wfmax').value=sp.wf_max_db; $('p-wfmaxv').textContent=sp.wf_max_db; }
        if (typeof sp.wf_min_db==='number'){ $('p-wfmin').value=sp.wf_min_db; $('p-wfminv').textContent=sp.wf_min_db; }
        if (typeof sp.max_db==='number'){ sc=sp.max_db; $('p-spmax').value=sc; $('p-spmaxv').textContent=sc; }
        if (typeof sp.min_db==='number'){ sf=sp.min_db; $('p-spmin').value=sf; $('p-spminv').textContent=sf; }
        buildDbLabels();
        resize();
        requestAnimationFrame(loop);
    }
}

function loop() {
    if (!paused) {
        resize();
        // Sync live state from radio.js each frame (skip during active pan)
        if (typeof window.frequencyHz !== 'undefined' && !_panSuppressSync) {
            const rKhz = window.frequencyHz/1000;
            const cKhz = window.centerHz/1000;
            const sKhz = (window.spectrum ? window.spectrum.spanHz : 0)/1000;
            if (Math.abs(rKhz-tuneKhz)>.5 || Math.abs(cKhz-centerKhz)>.5 || Math.abs(sKhz-spanKhz)>.5) {
                tuneKhz = rKhz; centerKhz = cKhz; spanKhz = sKhz;
                updateFDisp(); buildDX();
            }
        }
        renderFromSource();
    }
    frame++;
    if (frame%8===0)  tickSM();
    if (frame%60===0) updateClock();
    requestAnimationFrame(loop);
}

// ═══════════════════════════════════════════════════════════════════
// CONTROLS
// ═══════════════════════════════════════════════════════════════════
function rjsTune(khz) {
    tuneKhz = khz;
    const inp = document.getElementById('freq');
    if (inp) {
        inp.value = khz.toFixed(3);
        if (typeof window.setFrequencyW === 'function') window.setFrequencyW();
    }
    updateFDisp();
}
function rjsMode(mode) {
    curMode = mode;
    if (typeof window.setMode === 'function') window.setMode(mode);
    drawScale(); updatePB();
}
function getStep() {
    const s = $('p-step').value;
    if (s.includes('MHz')) return parseFloat(s)*1000;
    if (/khz/i.test(s)) return parseFloat(s);
    return parseFloat(s)/1000;
}

$('p-fnum').addEventListener('focus', ()=>{ $('p-fnum').removeAttribute('readonly'); $('p-fnum').select(); });
$('p-fnum').addEventListener('blur', ()=>{ $('p-fnum').setAttribute('readonly',''); $('p-fnum').value = tuneKhz.toFixed(3); });
$('p-fnum').addEventListener('keydown', e=>{
  if(e.key==='Enter'){ e.preventDefault(); const v=parseFloat($('p-fnum').value); if(!isNaN(v)){ rjsTune(v); $('p-fnum').blur(); } }
  if(e.key==='Escape'){ $('p-fnum').blur(); }
});
$('p-dn').onclick = ()=>rjsTune(Math.max(1, tuneKhz-getStep()));
$('p-up').onclick = ()=>rjsTune(tuneKhz+getStep());

document.querySelectorAll('#p-inner [data-mode]').forEach(btn=>{
    btn.onclick = ()=>{
        document.querySelectorAll('#p-inner [data-mode]').forEach(b=>b.classList.remove('sel'));
        btn.classList.add('sel'); rjsMode(btn.dataset.mode);
    };
});


$('p-zo').onclick  = ()=>{ if(typeof window.zoomout==='function') window.zoomout(); };
$('p-zi').onclick  = ()=>{ if(typeof window.zoomin==='function')  window.zoomin();  };
$('p-pl').onclick  = ()=>{ centerKhz-=spanKhz*.2; sendCenter(centerKhz); buildDX(); drawScale(); updatePB(); };
$('p-pr').onclick  = ()=>{ centerKhz+=spanKhz*.2; sendCenter(centerKhz); buildDX(); drawScale(); updatePB(); };
$('p-ctr').onclick = ()=>{ if(typeof window.zoomcenter==='function') window.zoomcenter(); };

$('p-aud').onclick = function(){
    this.classList.toggle('sel');
    if (typeof window.audio_start_stop==='function') window.audio_start_stop();
};
$('p-vol').oninput = function(){
    $('p-volv').textContent = this.value;
    if (typeof window.setPlayerVolume==='function') window.setPlayerVolume(+this.value/100);
};
$('p-wfmax').oninput = function(){ const v=+this.value; $('p-wfmaxv').textContent=v; if(window.spectrum) window.spectrum.wf_max_db=v; };
$('p-wfmin').oninput = function(){ const v=+this.value; $('p-wfminv').textContent=v; if(window.spectrum) window.spectrum.wf_min_db=v; };
$('p-spmax').oninput = function(){ sc=+this.value; $('p-spmaxv').textContent=sc; if(window.spectrum) window.spectrum.max_db=sc; buildDbLabels(); };
$('p-spmin').oninput = function(){ sf=+this.value; $('p-spminv').textContent=sf; if(window.spectrum) window.spectrum.min_db=sf; buildDbLabels(); };
$('p-run').onclick  = function(){
    paused=!paused; this.textContent=paused?'⏸ Paused':'▶ Run';
    if(paused) this.classList.remove('sel'); else this.classList.add('sel');
};

$('p-tbar-arr').onclick = ()=>{
    const closed = $('p-tbar').classList.toggle('closed');
    $('p-tbar-arr').textContent = closed?'▼':'▲';
    $('p-panel').classList.toggle('fullh',closed);
    setTimeout(resize,180);
};
$('p-vis').onclick = ()=>{
    const c = $('p-panel').classList.toggle('collapsed');
    $('p-vis').textContent = c?'▶':'◀';
    setTimeout(resize,20);
};

// ── Diagnostics ───────────────────────────────────────────────────
const DIAG = {
    'Tune':      ()=>typeof window.frequencyHz!=='undefined'?(window.frequencyHz/1e6).toFixed(6)+' MHz':'—',
    'RF Gain':   ()=>window.rf_gain!==undefined?window.rf_gain.toFixed(1)+' dB':'—',
    'RF Atten':  ()=>window.rf_atten!==undefined?window.rf_atten.toFixed(1)+' dB':'—',
    'RF AGC':    ()=>window.rf_agc!==undefined?(window.rf_agc==1?'enabled':'disabled'):'—',
    'A/D':       ()=>window.if_power!==undefined?window.if_power.toFixed(1)+' dBFS':'—',
    'SSRC':      ()=>window.ssrc!==undefined?window.ssrc:'—',
    'Bins':      ()=>window.binCount!==undefined?window.binCount.toLocaleString():'1,620',
    'Bin width': ()=>window.binWidthHz!==undefined?window.binWidthHz.toLocaleString()+' Hz':'—',
    'Overranges':()=>window.ad_over!==undefined?window.ad_over.toLocaleString():'—',
    'N₀':        ()=>window.noise_density_audio!==undefined?window.noise_density_audio.toFixed(1)+' dBm/Hz':'—',
    'Zoom':      ()=>{ try{return document.getElementById('zoom_level').value;}catch(e){return '—';} },
    'Span':      ()=>`${((centerKhz-spanKhz/2)/1000).toFixed(3)}–${((centerKhz+spanKhz/2)/1000).toFixed(3)} MHz`,
    'specH':     ()=>window.spectrum?window.spectrum.spectrumHeight:'—',
    'srcSize':   ()=>_src?`${_src.width}×${_src.height}`:'waiting…',
};
function updateDiag() {
    if (!diagOpen) return;
    const grid = $('p-dg-grid'); grid.innerHTML='';
    for (const [l,fn] of Object.entries(DIAG)) {
        const le=document.createElement('span'); le.style.cssText='color:#aaa;white-space:nowrap'; le.textContent=l+':';
        const ve=document.createElement('span'); ve.style.cssText='color:#eee;white-space:nowrap'; ve.textContent=fn();
        grid.appendChild(le); grid.appendChild(ve);
    }
    const wwv = document.getElementById('wwv_solar');
    if (wwv && wwv.textContent) $('p-dg-solar').textContent = wwv.textContent;
}
setInterval(updateDiag, 2000);
$('p-dg-hdr').onclick = ()=>{
    diagOpen=!diagOpen;
    $('p-dg-body').style.display=diagOpen?'block':'none';
    $('p-dg-arr').textContent=diagOpen?'hide':'show';
    $('p-dg-title').textContent=(diagOpen?'▾':'▸')+' RADIO STATUS';
    if(diagOpen) updateDiag();
};

// ── Mouse / trackpad interactions on overlay canvases ─────────────
// Pan:  press-and-drag (mouse or trackpad click-drag)
//       horizontal two-finger scroll (trackpad deltaX)
// Zoom: mouse wheel, trackpad pinch (ctrlKey + wheel), two-finger
//       vertical scroll
// Click: tune to the clicked frequency
// ──────────────────────────────────────────────────────────────────
let drag = null;
let _panSuppressSync = false;   // block loop() center sync during drag
let _lastPanSend = 0;
const PAN_SEND_MS = 50;        // throttle Z:c: sends during drag

let _zoomAccum = 0;            // accumulate small pinch deltas
let _zoomTimer = null;

// Send a center-frequency command to the backend + update spectrum
function sendCenter(khz) {
    let sent = false;
    try {
        if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send('Z:c:' + khz.toFixed(3));
            sent = true;
        }
    } catch (e) {
        console.warn('[overlay] sendCenter: ws not accessible', e);
    }
    const hasSCH = window.spectrum && typeof window.spectrum.setCenterHz === 'function';
    if (hasSCH) window.spectrum.setCenterHz(khz * 1000);
    console.log('[overlay] sendCenter', khz.toFixed(1), 'kHz  ws=' + sent, 'sCH=' + !!hasSCH);
}

[$('p-wf'),$('p-sp'),$('p-sc')].forEach(cv => {
    cv.style.pointerEvents = 'all'; cv.style.cursor = 'crosshair';

    // ── mousedown: start drag ────────────────────────────────────
    cv.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        drag = { sx: e.clientX, sc0: centerKhz, moved: false, cv: cv };
        cv.style.cursor = 'grabbing';
    });

    // ── mousemove on canvas: tooltip only ────────────────────────
    cv.addEventListener('mousemove', e => {
        const r  = cv.getBoundingClientRect();
        const f  = (centerKhz - spanKhz/2) + ((e.clientX - r.left) / r.width) * spanKhz;
        const tip = $('p-tip'), wr = $('p-wf-wrap').getBoundingClientRect();
        tip.style.display = 'block';
        tip.style.left = Math.min(e.clientX - wr.left + 8, wr.width - 90) + 'px';
        tip.textContent = (f / 1000).toFixed(4) + ' MHz';
    });

    cv.addEventListener('mouseleave', () => { $('p-tip').style.display = 'none'; });

    // ── wheel: zoom or horizontal pan ────────────────────────────
    cv.addEventListener('wheel', e => {
        e.preventDefault();
        console.log('[overlay] wheel  dX=' + e.deltaX.toFixed(1),
                     'dY=' + e.deltaY.toFixed(1),
                     'mode=' + e.deltaMode,
                     'ctrl=' + e.ctrlKey,
                     'target=' + cv.id);

        // Horizontal two-finger scroll → pan
        if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5
                       && Math.abs(e.deltaX) > 2) {
            const r = cv.getBoundingClientRect();
            centerKhz += (e.deltaX / r.width) * spanKhz * 0.5;
            console.log('[overlay] → horiz pan', centerKhz.toFixed(1));
            sendCenter(centerKhz);
            buildDX(); drawScale(); updatePB();
            return;
        }

        // Vertical scroll / pinch → zoom via backend zoomin/zoomout
        // Normalize deltaY: deltaMode 1 = lines (~30 px each)
        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 30;
        _zoomAccum += dy;

        // Immediate trigger for large deltas (mouse wheel notch)
        if (Math.abs(_zoomAccum) >= 40) {
            const fn = _zoomAccum > 0 ? 'zoomout' : 'zoomin';
            console.log('[overlay] → immediate zoom:', fn,
                        'avail=' + (typeof window[fn] === 'function'));
            if (_zoomAccum > 0 && typeof window.zoomout === 'function') window.zoomout();
            else if (_zoomAccum < 0 && typeof window.zoomin === 'function') window.zoomin();
            _zoomAccum = 0;
            if (_zoomTimer) { clearTimeout(_zoomTimer); _zoomTimer = null; }
            return;
        }
        // Deferred trigger for small deltas (trackpad pinch)
        if (!_zoomTimer) {
            _zoomTimer = setTimeout(() => {
                console.log('[overlay] → deferred zoom accum=' + _zoomAccum.toFixed(1));
                if (_zoomAccum > 5 && typeof window.zoomout === 'function') window.zoomout();
                else if (_zoomAccum < -5 && typeof window.zoomin === 'function') window.zoomin();
                _zoomAccum = 0;
                _zoomTimer = null;
            }, 120);
        }
    }, { passive: false });
});

// ── window-level drag (pan) handlers ─────────────────────────────
// Attached to window so the drag continues even if the pointer
// leaves the canvas (important for trackpad press-and-drag).
window.addEventListener('mousemove', e => {
    if (!drag) return;
    const r  = drag.cv.getBoundingClientRect();
    const dx = e.clientX - drag.sx;
    if (!drag.moved && Math.abs(dx) > 3) {
        drag.moved = true; _panSuppressSync = true;
        console.log('[overlay] drag started');
    }
    if (drag.moved) {
        centerKhz = drag.sc0 - (dx / r.width) * spanKhz;
        const now = Date.now();
        if (now - _lastPanSend >= PAN_SEND_MS) {
            sendCenter(centerKhz);
            _lastPanSend = now;
        }
        buildDX(); drawScale(); updatePB();
    }
});
window.addEventListener('mouseup', e => {
    if (e.button !== 0 || !drag) return;
    if (!drag.moved) {
        const r = drag.cv.getBoundingClientRect();
        const freq = (centerKhz - spanKhz/2) + ((e.clientX - r.left) / r.width) * spanKhz;
        console.log('[overlay] click-tune', (freq/1000).toFixed(4), 'MHz');
        rjsTune(freq);
    } else {
        console.log('[overlay] drag end → final sendCenter', centerKhz.toFixed(1));
        sendCenter(centerKhz);
        _panSuppressSync = false;
    }
    drag.cv.style.cursor = 'crosshair';
    drag = null;
});

window.addEventListener('resize', resize);
updateClock(); setInterval(updateClock,1000);

// Kick off the readiness poll — loop starts only once conditions are met
waitForReady();

})();