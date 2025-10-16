import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, EXTERNAL_PORTAL_URL } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = sel => document.querySelector(sel);
const show = sel => $(sel).classList.remove('hidden');
const hide = sel => $(sel).classList.add('hidden');
let CURRENT_ROL = 'trabajador';

// Tabs
document.addEventListener('click', (e)=>{
  const btn = e.target.closest('.tab'); if (!btn) return;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelectorAll('.tabview').forEach(v=>v.classList.remove('active'));
  btn.classList.add('active');
  const name = btn.dataset.tab;
  $("#tab-"+name).classList.add('active');
});
$("#iframe-externo").src = EXTERNAL_PORTAL_URL;

// Auth
async function refresh() {
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    hide("#view-login"); show("#view-app");
    $("#btn-login").classList.add("hidden");
    $("#btn-logout").classList.remove("hidden");
    loadData();
  } else {
    show("#view-login"); hide("#view-app");
    $("#btn-login").classList.remove("hidden");
    $("#btn-logout").classList.add("hidden");
  }
}

document.querySelector("#login-form").addEventListener("submit", async (e)=>{
  e.preventDefault();
  const email = $("#email").value.trim();
  const password = $("#password").value;
  $("#login-msg").classList.add("hidden");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error){ $("#login-msg").textContent = error.message; $("#login-msg").classList.remove("hidden"); return; }
  refresh();
});
document.querySelector("#btn-login").addEventListener("click", ()=>{ show("#view-login"); hide("#view-app"); });
document.querySelector("#btn-logout").addEventListener("click", async ()=>{ await supabase.auth.signOut(); location.reload(); });

async function loadData(){
  try {
    // Perfil y rol
    const meRes = await supabase.from('usuarios').select('*').maybeSingle();
    if (meRes.error) $("#perfil").innerHTML = `<span class="muted">${meRes.error.message}</span>`;
    else if (meRes.data) $("#perfil").innerHTML = `<div><strong>${meRes.data.nombre||'—'}</strong></div><div class="muted">${meRes.data.email||''}</div>`;
    else $("#perfil").innerHTML = `<span class="muted">Sin registro en usuarios</span>`;

    const rol = (meRes.data?.rol || 'trabajador').toLowerCase();
    CURRENT_ROL = rol;
    if (rol === 'salud') { document.querySelectorAll('.tab-salud').forEach(t=>t.classList.remove('hidden')); }
    else { document.querySelectorAll('.tab-salud').forEach(t=>t.classList.add('hidden')); }

    // KPIs
    const trabRes = await supabase.from('trabajadores').select('*').maybeSingle();
    let kpis = [];
    if (trabRes.data){
      const t = trabRes.data;
      const imc = calcIMC(t.peso_kg, t.altura_cm);
      const edad = calcEdad(t.fecha_nacimiento);
      kpis = [
        { title:'Edad', value:isNaN(edad)?'—':`${edad} años` },
        { title:'IMC', value:isNaN(imc)?'—':imc.toFixed(1) },
        { title:'Empresa', value: t.empresa ?? '—' }
      ];
      // Banner de IMC
      if (!isNaN(imc)){
        if (imc >= 30) showTopAlert('danger','Atención: IMC Alto','Tu IMC está en rango de obesidad. Agenda control y refuerza hábitos.');
        else if (imc >= 25) showTopAlert('warning','Aviso: IMC Elevado','Tu IMC está en sobrepeso. Revisa pausas activas y alimentación.');
      }
    }
    document.querySelector("#kpis").innerHTML = kpis.map(k=>`<div class="kpi"><div class="title">${k.title}</div><div class="value">${k.value}</div></div>`).join('');

    // Alertas + chip (ejemplo: vence en x días desde una vista v_alertas si la tienes)
    const evalsRes = await supabase.from('v_alertas').select('*').order('dias_restantes');
    renderAlertas(evalsRes.data || []);
    setStatusChip(evalsRes.data || []);

    // Labs
    const labsRes = await supabase.from('examenes').select('*').order('fecha', { ascending:false }).limit(200);
    const full = labsRes.data ?? [];
    renderLabs(full);
    $("#filtro-labs").addEventListener("input", (e)=>{
      const q = e.target.value.trim().toLowerCase();
      const filtered = full.filter(l =>
        (l.tipo||'').toLowerCase().includes(q) ||
        (l.parametro||'').toLowerCase().includes(q) ||
        (l.interpretacion||'').toLowerCase().includes(q)
      );
      renderLabs(filtered);
    });

    // Higiene (idealmente ya filtrado por RLS)
    const higRes = await supabase.from('v_higiene').select('*').order('fecha', { ascending:false }).limit(200);
    renderHigiene(higRes.data || []);

    // Citaciones (filtrar por RUT del usuario logueado)
    const meRut = meRes.data?.rut || null;
    const citaRes = meRut
      ? await supabase.from('citaciones').select('*').eq('rut', meRut).order('fecha')
      : { data: [] };
    renderCitaciones(citaRes);

    // Recomendaciones
    loadGlobalPDF();
    loadGlobalImages();
    const recos = buildRecommendations(trabRes.data, full);
    document.querySelector("#reco-cards").innerHTML = recos.length
      ? recos.map(r=>`<div class="reco"><strong>${r.title}</strong><div class="muted">${r.detail}</div></div>`).join('')
      : `<span class="muted">Sin recomendaciones específicas. ¡Buen trabajo!</span>`;

    // Dashboard Salud — opcional, carga tus resúmenes y gráficos aquí.
    if (CURRENT_ROL === 'salud'){
      // TODO: cargar vistas resumen_* si las tienes
      // $('#dash-msg').textContent = 'Listo.';
      setupSupervisor(); // activar supervisor solo SALUD
    }
  } catch (e) {
    console.error("Error en loadData:", e);
  }
}

supabase.auth.onAuthStateChange((_event, _session)=>{ refresh(); });
refresh();

// --------- UI helpers ----------
function setStatusChip(items){
  const chip = $("#status-chip");
  if (!items.length){ chip.textContent = "OK"; chip.className = "chip"; return; }
  chip.textContent = `${items.length} alertas`; chip.className = "chip brand";
}
function renderAlertas(rows){
  const el = $("#alertas"); if (!el) return;
  if (!rows.length){ el.innerHTML = '<span class="muted">Sin alertas.</span>'; return; }
  el.innerHTML = rows.map(a=>`<div class="item"><div>${a.titulo||a.tipo||'Alerta'}</div><span class="badge brand">${a.dias_restantes ?? ''} días</span></div>`).join('');
}
function renderLabs(rows){
  const body = $("#labs tbody"); if (!body) return;
  if (!rows.length){ body.innerHTML = `<tr><td colspan="6" class="muted">Sin datos</td></tr>`; return; }
  body.innerHTML = rows.map(l=>`<tr>
    <td>${l.tipo||''}</td><td>${l.parametro||''}</td><td>${fmtDate(l.fecha)}</td>
    <td>${l.resultado||''}</td><td>${l.referencia||''}</td><td>${l.interpretacion||''}</td>
  </tr>`).join('');
  const body2 = $("#labs-2 tbody"); if (body2) body2.innerHTML = body.innerHTML;
}
function renderHigiene(rows){
  const body = $("#hig tbody"); if (!body) return;
  if (!rows.length){ body.innerHTML = `<tr><td colspan="6" class="muted">Sin datos</td></tr>`; $("#hig-msg").textContent = ""; return; }
  body.innerHTML = rows.map(h=>`<tr>
    <td>${h.agente||''}</td><td>${h.ges||''}</td><td>${fmtDate(h.fecha)}</td>
    <td>${h.valor||''}</td><td>${h.oel||''}</td><td>${h.nivel||''}</td>
  </tr>`).join('');
}
function renderCitaciones(res){
  const body = $("#cit tbody"); if (!body) return;
  const rows = res?.data ?? [];
  if (!rows.length){ body.innerHTML = `<tr><td colspan="6" class="muted">Sin citaciones</td></tr>`; return; }
  body.innerHTML = rows.map(c=>`<tr>
    <td>${fmtDate(c.fecha)}</td><td>${c.hora||''}</td><td>${c.tipo||''}</td><td>${c.centro||''}</td><td>${c.direccion||''}</td><td>${c.estado||''}</td>
  </tr>`).join('');
}

// Reco simples en base a labs
function buildRecommendations(t, labs){
  const recos = [];
  const last = (param)=> labs.filter(x=> (x.parametro||'').toLowerCase()===param).sort((a,b)=>new Date(b.fecha)-new Date(a.fecha))[0];
  const imc = calcIMC(t?.peso_kg, t?.altura_cm);
  if (!isNaN(imc)){
    if (imc >= 30) recos.push({ title: "IMC alto (≥30)", detail: "Derivación a nutrición y plan de actividad física." });
    else if (imc >= 25) recos.push({ title: "IMC elevado (25–29.9)", detail: "Pausas activas, hidratación y revisión de colación." });
  }
  const glu = last('glucosa'); if (glu){ const v=parseNumber(glu.resultado);
    if (!isNaN(v)){ if (v >= 126) recos.push({ title: "Glucosa elevada (≥126)", detail: "Agenda control médico." });
      else if (v >= 100) recos.push({ title: "Glucosa 100–125", detail: "Reduce azúcares simples, aumenta fibra y proteína." });
      else recos.push({ title: "Glucosa normal", detail: "Mantén dieta equilibrada." });
  } }
  const chol = last('colesterol total'); if (chol){ const v=parseNumber(chol.resultado);
    if (!isNaN(v)){ if (v >= 240) recos.push({ title: "Colesterol alto (≥240)", detail: "Consulta médica y ajustes de dieta." });
      else if (v >= 200) recos.push({ title: "Colesterol límite (200–239)", detail: "Ajustes de dieta y actividad física." });
      else recos.push({ title: "Colesterol deseable (<200)", detail: "Sigue con hábitos actuales." });
  } }
  return recos;
}

// ---------- Supervisor (solo SALUD) ----------
function setupSupervisor(){
  if (CURRENT_ROL !== 'salud') return;
  const input = document.querySelector('#srch'); if (!input) return;
  const results = document.querySelector('#srch-results');
  const clear = document.querySelector('#btn-clear');
  let lastQ = "", timer;
  clear.addEventListener('click', ()=>{
    input.value = ""; results.innerHTML = ""; document.querySelector('#sup-detail').style.display = 'none';
  });
  input.addEventListener('input', (e)=>{
    const q = e.target.value.trim(); if (q === lastQ) return; lastQ = q;
    clearTimeout(timer); if (!q){ results.innerHTML = ""; return; }
    timer = setTimeout(()=> searchWorkers(q, results), 280);
  });
}

async function searchWorkers(q, container){
  container.innerHTML = `<span class="muted">Buscando…</span>`;
  // Si usas vista:
  const source = (CURRENT_ROL==='salud') ? 'v_usuarios_busqueda' : 'usuarios';
  const u = await supabase.from(source).select('rut,nombre,email')
    .or(`nombre.ilike.%${q}%,email.ilike.%${q}%,rut.ilike.%${q}%`)
    .limit(20);
  if (u.error){ container.innerHTML = `<span class="muted">${u.error.message}</span>`; return; }
  if (!u.data?.length){ container.innerHTML = `<span class="muted">Sin resultados</span>`; return; }

  // Enriquecer con gerencia/empresa
  const ruts = u.data.map(x=>x.rut).filter(Boolean);
  let mapTrab = {};
  if (ruts.length){
    const t = await supabase.from('trabajadores').select('rut,gerencia,empresa').in('rut', ruts);
    if (!t.error && t.data){ mapTrab = Object.fromEntries(t.data.map(x=>[x.rut, x])); }
  }

  container.innerHTML = u.data.map(w=>{
    const t = mapTrab[w.rut] || {};
    return `<div class="row" style="justify-content:space-between;border:1px solid #e5e7eb;padding:8px;border-radius:12px;cursor:pointer" data-rut="${w.rut}">
      <div><strong>${w.nombre||'Sin nombre'}</strong><div class="muted">${w.email||''} ${t.gerencia? '• '+t.gerencia:''}</div></div>
      <span class="badge">Ver</span>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-rut]').forEach(el=>{
    el.addEventListener('click', ()=> loadWorkerDetail(el.dataset.rut));
  });
}

async function loadWorkerDetail(rut){
  if (CURRENT_ROL !== 'salud') return;
  document.querySelector('#sup-detail').style.display = 'block';
  const { data: t } = await supabase.from('trabajadores').select('*').eq('rut', rut).maybeSingle();
  const { data: u } = await supabase.from('usuarios').select('email,nombre').eq('rut', rut).maybeSingle();
  const email = u?.email || t?.email || '';
  const nombre = u?.nombre || t?.nombre || 'Sin nombre';
  $("#sup-perfil").innerHTML = t ? `<div><strong>${nombre}</strong></div>
    <div class="muted">${email}</div><div class="muted">${t.empresa||'—'} • ${t.gerencia||'—'}</div>
    <div class="muted">RUT: ${rut}</div>` : `<div><strong>${nombre}</strong></div><div class="muted">${email}</div><div class="muted">RUT: ${rut}</div>`;
  const imc = calcIMC(t?.peso_kg, t?.altura_cm);
  const edad = calcEdad(t?.fecha_nacimiento);
  const kpis = [
    { title:'Edad', value:isNaN(edad)?'—':`${edad} años` },
    { title:'IMC', value:isNaN(imc)?'—':imc.toFixed(1) },
    { title:'Altura', value: t?.altura_cm? `${t.altura_cm} cm` : '—' }
  ];
  $("#sup-kpis").innerHTML = kpis.map(k=>`<div class="kpi"><div class="title">${k.title}</div><div class="value">${k.value}</div></div>`).join('');

  const cit = await supabase.from('citaciones').select('*').eq('rut', rut).order('fecha');
  const bodyC = $("#sup-cit tbody");
  bodyC.innerHTML = (cit.data||[]).map(c=>`<tr><td>${fmtDate(c.fecha)}</td><td>${c.hora||''}</td><td>${c.tipo||''}</td><td>${c.centro||''}</td><td>${c.direccion||''}</td><td>${c.estado||''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">—</td></tr>`;

  const labs = await supabase.from('examenes').select('*').eq('rut', rut).order('fecha',{ascending:false}).limit(200);
  $("#sup-labs tbody").innerHTML = (labs.data||[]).map(l=>`<tr><td>${l.tipo||''}</td><td>${l.parametro||''}</td><td>${fmtDate(l.fecha)}</td><td>${l.resultado||''}</td><td>${l.referencia||''}</td><td>${l.interpretacion||''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">—</td></tr>`;

  const hig = await supabase.from('v_higiene').select('*').eq('rut', rut).order('fecha',{ascending:false}).limit(200);
  $("#sup-hig tbody").innerHTML = (hig.data||[]).map(h=>`<tr><td>${h.agente||''}</td><td>${h.ges||''}</td><td>${fmtDate(h.fecha)}</td><td>${h.valor||''}</td><td>${h.oel||''}</td><td>${h.nivel||''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">—</td></tr>`;
}

// -------- Recomendaciones globales: PDF + Imágenes --------
async function loadGlobalPDF(){
  try{
    const { data } = await supabase.storage.from('recomendaciones').getPublicUrl('global.pdf');
    const url = data?.publicUrl || null;
    const frame = document.querySelector('#global-pdf');
    const msg = document.querySelector('#file-msg');
    if (frame && url) frame.src = url; else if (msg) msg.textContent = 'No hay PDF global cargado.';
  }catch{ const m=document.querySelector('#file-msg'); if (m) m.textContent='No fue posible cargar el PDF global.'; }
}
async function loadGlobalImages(){
  const gal = document.querySelector('#img-gallery'); if (!gal) return;
  gal.innerHTML = '<span class="muted">Cargando…</span>';
  const { data:list, error } = await supabase.storage.from('recomendaciones').list('imagenes', { limit:100, sortBy:{column:'created_at', order:'desc'} });
  if (error){ gal.innerHTML = `<span class="muted">${error.message}</span>`; return; }
  if (!list || !list.length){ gal.innerHTML = '<span class="muted">Sin imágenes cargadas.</span>'; return; }
  const items = list.filter(x=>!x.name.starts_with('.'));
  const htmls = await Promise.all(items.map(async f=>{
    const { data:urlData } = await supabase.storage.from('recomendaciones').getPublicUrl(`imagenes/${f.name}`);
    const url = urlData?.publicUrl;
    return `
      <div class="thumb">
        <img src="${url}" alt="${f.name}">
        <div class="row">
          <span class="muted" title="${f.name}">${f.name.slice(0,16)}${f.name.length>16?'…':''}</span>
          ${ (window.CURRENT_ROL==='salud') ? `<button class="btn outline" data-del="${f.name}">Eliminar</button>` : '' }
        </div>
      </div>`;
  }));
  gal.innerHTML = htmls.join('');
  if (window.CURRENT_ROL==='salud'){
    gal.querySelectorAll('[data-del]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const name = btn.getAttribute('data-del');
        if (!confirm(`¿Eliminar ${name}?`)) return;
        const { error } = await supabase.storage.from('recomendaciones').remove([`imagenes/${name}`]);
        if (error){ alert('Error al eliminar: '+error.message); return; }
        loadGlobalImages();
      });
    });
  }
}
function setupFileUpload(){
  const btn = document.querySelector('#btn-upload');
  const inp = document.querySelector('#file-upload');
  const msg = document.querySelector('#file-msg');
  if (!btn || !inp) return;
  if (typeof CURRENT_ROL !== 'string' || CURRENT_ROL !== 'salud'){
    btn.style.display = 'none'; inp.style.display = 'none'; return;
  }
  btn.addEventListener('click', async ()=>{
    const files = Array.from(inp.files || []);
    if (!files.length){ if (msg) msg.textContent='Selecciona uno o más archivos.'; return; }
    if (msg) msg.textContent='Subiendo…';
    for (const f of files){
      try{
        if (f.type === 'application/pdf'){
          const { error } = await supabase.storage.from('recomendaciones').upload('global.pdf', f, { upsert:true, contentType:'application/pdf' });
          if (error) throw error;
        } else if (f.type.startsWith('image/')){
          const ts = new Date().toISOString().replace(/[:.]/g,'-');
          const base = f.name.replace(/[^a-zA-Z0-9._-]/g,'_');
          const key = `imagenes/${ts}_${base}`;
          const { error } = await supabase.storage.from('recomendaciones').upload(key, f, { upsert:false, contentType:f.type });
          if (error) throw error;
        } else {
          if (msg) msg.textContent='Formato no soportado (solo PDF o imágenes).';
        }
      }catch(e){ if (msg) msg.textContent='Error al subir: '+e.message; }
    }
    if (msg) msg.textContent='Carga finalizada.';
    loadGlobalPDF();
    loadGlobalImages();
    inp.value = "";
  });
}
document.addEventListener('DOMContentLoaded', setupFileUpload);

// ---- utils ----
function parseNumber(x){ const v = parseFloat(String(x).replace(',','.')); return isNaN(v)?NaN:v; }
function calcIMC(peso_kg, altura_cm){ const p=parseNumber(peso_kg), a=parseNumber(altura_cm); if (isNaN(p)||isNaN(a)||a===0) return NaN; return p/Math.pow(a/100,2); }
function calcEdad(fecha){ if (!fecha) return NaN; const d=new Date(fecha); if (isNaN(d)) return NaN; const dif=Date.now()-d.getTime(); return Math.floor(dif/31557600000); }
function fmtDate(s){ if (!s) return ''; const d=new Date(s); if (isNaN(d)) return s; return d.toISOString().slice(0,10); }
function showTopAlert(kind, title, detail){
  const el = document.querySelector('#top-alert');
  if (!el) return;
  el.className = 'alert-banner visible';
  if (kind==='warning') el.classList.add('alert-warning');
  if (kind==='danger') el.classList.add('alert-danger');
  el.innerHTML = `<strong>${title}</strong><div class="muted">${detail}</div>`;
}
