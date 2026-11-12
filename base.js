// Soonstep Comm, téléphone : clé, contenu chiffré, visuels, et la même base Google que les
// applis Mac et Windows (même protocole que main/noyau.js : lire, ecrire, file hors ligne).
'use strict';

(() => {
  // Téléphone tourné à l'horizontale : d'après l'écran lui-même. La fenêtre visible ne suffit pas :
  // le clavier d'Android la rend plus large que haute, sans que le téléphone ait tourné.
  const majPaysage = () => {
    const type = (screen.orientation && screen.orientation.type) || (Math.abs(Number(window.orientation) || 0) === 90 ? 'landscape' : 'portrait');
    const petitEcran = Math.min(screen.width, screen.height) <= 520;
    document.documentElement.classList.toggle('paysage-vrai', type.startsWith('landscape') && petitEcran);
  };
  majPaysage();
  if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', majPaysage);
  window.addEventListener('orientationchange', majPaysage);

  const enc = (s) => new TextEncoder().encode(s);
  const SEL = enc('soonstep-comm-mobile');
  const MIMES = { png: 'image/png', jpg: 'image/jpeg', mp4: 'video/mp4', pdf: 'application/pdf' };
  const L = {
    lire(cle, defaut) { try { const v = localStorage.getItem(`sc-${cle}`); return v === null ? defaut : JSON.parse(v); } catch { return defaut; } },
    ecrire(cle, v) { try { localStorage.setItem(`sc-${cle}`, JSON.stringify(v)); } catch { /* stockage plein ou bloqué */ } },
    effacer(cle) { try { localStorage.removeItem(`sc-${cle}`); } catch { /* rien */ } },
  };

  // ─── Clé et contenu ─────────────────────────

  // Le contenu s'ouvre avec la clé du lien ET le mot de passe : l'un sans l'autre ne sert à rien.
  // Le mot de passe passe par PBKDF2 (lent exprès) ; le téléphone garde le résultat, pas le mot de passe.
  const b64 = (o) => btoa(String.fromCharCode(...o));
  const deb64 = (t) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  async function secretMdp(cle, mdp) {
    const base = await crypto.subtle.importKey('raw', enc(mdp.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(`soonstep-comm-mobile|${cle}`), iterations: 600000 }, base, 256);
    return b64(new Uint8Array(bits));
  }
  async function cleAes(cle, secret) {
    const s = deb64(secret);
    const c = enc(cle);
    const brut = new Uint8Array(c.length + s.length);
    brut.set(c);
    brut.set(s, c.length);
    const ikm = await crypto.subtle.importKey('raw', brut, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SEL, info: enc('contenu v2') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  }
  const dechiffrer = (k, octets) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: octets.slice(0, 12) }, k, octets.slice(12));

  async function telecharger(url, essais = 3, options = {}) {
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(url, options);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      } catch (err) {
        if (i >= essais - 1) throw err;
        await new Promise((ok) => setTimeout(ok, 600 * (i + 1)));
      }
    }
  }

  let K = null;
  let paquet = null;

  /** Ouvre le contenu avec la clé et le mot de passe. Rejette « cle » s'ils ne l'ouvrent pas. */
  async function ouvrir(cle, secret) {
    K = await cleAes(cle, secret);
    const brut = await telecharger(`d/contenu.bin?t=${Date.now()}`, 3, { cache: 'no-store' });
    let clair;
    try { clair = await dechiffrer(K, brut); } catch { throw new Error('cle'); }
    paquet = JSON.parse(new TextDecoder().decode(clair));
    return paquet;
  }

  // ─── Visuels ───────────────────────────────

  const urls = new Map();
  const enCours = new Map();
  let actifs = 0;
  const file = [];
  const prendreTour = () => new Promise((ok) => { if (actifs < 5) { actifs += 1; ok(); } else file.push(ok); });
  const rendreTour = () => { const suivant = file.shift(); if (suivant) suivant(); else actifs -= 1; };

  /** Blob déchiffré d'un fichier du contenu (« media/x.png », « vignettes/x.jpg », « gen/… »). */
  function blob(nom, prioritaire = false) {
    if (enCours.has(nom)) return enCours.get(nom);
    const chiffre = paquet.fichiers[nom];
    if (!chiffre) return Promise.reject(new Error(`absent : ${nom}`));
    const travail = (async () => {
      if (!prioritaire) await prendreTour();
      try {
        const clair = await dechiffrer(K, await telecharger(`d/${chiffre}`));
        return new Blob([clair], { type: MIMES[nom.split('.').pop()] || 'application/octet-stream' });
      } finally {
        if (!prioritaire) rendreTour();
      }
    })();
    enCours.set(nom, travail);
    travail.catch(() => enCours.delete(nom));
    return travail;
  }
  const urlPrete = (nom) => urls.get(nom) || null;
  async function url(nom, prioritaire) {
    if (urls.has(nom)) return urls.get(nom);
    const u = URL.createObjectURL(await blob(nom, prioritaire));
    urls.set(nom, u);
    return u;
  }
  const existe = (nom) => !!(paquet && paquet.fichiers[nom]);

  // ─── Base partagée ─────────────────────────

  const PREFS_DEFAUT = { moi: null };

  class Noyau {
    constructor(cle) {
      this.cle = cle;
      this.ecouteurs = { etat: [], conflit: [] };
      this.prefs = { ...PREFS_DEFAUT, ...L.lire('prefs', {}) };
      const cache = L.lire('etat', { serveur: null, attente: [] });
      this.serveur = cache.serveur || { rev: null, posts: {}, tournages: {}, reglages: {}, journal: [] };
      this.attente = cache.attente || [];
      this.synchro = { statut: 'attente', derniere: L.lire('derniere', null), erreur: null };
      this.enCours = null;
      this.depot = false;
    }

    sur(type, f) { this.ecouteurs[type].push(f); }
    emettre(type, v) { for (const f of this.ecouteurs[type]) f(v); }

    vue() {
      const v = { rev: this.serveur.rev, posts: {}, tournages: {}, reglages: { ...this.serveur.reglages }, journal: this.serveur.journal || [] };
      for (const [k, p] of Object.entries(this.serveur.posts)) v.posts[k] = { ...p };
      for (const [k, t] of Object.entries(this.serveur.tournages)) v.tournages[k] = { ...t };
      for (const op of this.attente) {
        const champs = op.champs || {};
        if (op.cible === 'post') v.posts[op.cle] = { ...v.posts[op.cle], ...champs };
        if (op.cible === 'tournage') v.tournages[op.cle] = { ...v.tournages[op.cle], ...champs };
        if (op.cible === 'reglage') v.reglages[op.cle] = champs.valeur;
      }
      return v;
    }

    publication() {
      return { etat: this.vue(), synchro: { ...this.synchro, attente: this.attente.length }, prefs: { ...this.prefs } };
    }
    annoncer() { this.emettre('etat', this.publication()); }
    sauver() { L.ecrire('etat', { serveur: this.serveur, attente: this.attente }); }

    reglerPrefs(modifs) {
      this.prefs = { ...this.prefs, ...modifs };
      L.ecrire('prefs', this.prefs);
      this.annoncer();
    }

    ecrire({ cible, cle, champs, resume, baseRev }) {
      const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this.attente.push({ id, cible, cle: String(cle), champs, resume, baseRev, qui: this.prefs.moi });
      this.sauver();
      this.annoncer();
      return this.synchroniser();
    }

    synchroniser() {
      if (this.enCours) { this.depot = true; return this.enCours; }
      this.enCours = this.tour().finally(() => {
        this.enCours = null;
        if (this.depot) { this.depot = false; this.synchroniser(); }
      });
      return this.enCours;
    }

    async tour() {
      try {
        this.synchro.statut = 'en cours';
        if (this.attente.length) await this.envoyer(); else await this.lire();
        this.synchro = { statut: 'ok', derniere: Date.now(), erreur: null };
        L.ecrire('derniere', this.synchro.derniere);
      } catch (err) {
        this.synchro = { statut: 'hors ligne', derniere: this.synchro.derniere, erreur: String(err.message || err) };
      }
      this.sauver();
      this.annoncer();
    }

    async transport(demande) {
      const ctrl = new AbortController();
      const minuteur = setTimeout(() => ctrl.abort(), 45000);
      try {
        // text/plain : pas de requête préalable, Google l'accepte d'une autre origine.
        const r = await fetch(paquet.url, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...demande, cle: this.cle }), redirect: 'follow', signal: ctrl.signal,
        });
        const texte = await r.text();
        try { return JSON.parse(texte); } catch { throw new Error(`Réponse inattendue (${r.status})`); }
      } finally {
        clearTimeout(minuteur);
      }
    }

    async lire() {
      const r = await this.transport({ action: 'lire', depuis: this.serveur.rev });
      if (!r.ok) throw new Error(r.erreur || 'Réponse invalide');
      if (!r.inchange) this.serveur = r.etat;
    }

    async envoyer() {
      const lot = this.attente.slice();
      const r = await this.transport({ action: 'ecrire', ops: lot });
      if (!r.ok) throw new Error(r.erreur || 'Réponse invalide');
      this.serveur = r.etat;
      const envoyes = new Set(lot.map((o) => o.id));
      this.attente = this.attente.filter((o) => !envoyes.has(o.id));
      for (const c of r.conflits || []) this.emettre('conflit', c);
    }
  }

  // ─── Amorce ────────────────────────────────
  // Le site public ne contient que ce fichier, le style et les polices. Tout le reste
  // (l'interface, les règles, les posts) arrive chiffré dans contenu.bin et ne s'exécute
  // qu'une fois déchiffré avec la clé du lien personnel.

  let CLE = null;
  const racine = () => document.getElementById('app');
  const accueil = (html) => {
    racine().innerHTML = `<div class="accueil"><span class="marque"><img src="img/glyphe-couleur.svg" alt="">Soonstep Comm</span>${html}</div>`;
  };
  const autonome = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  /** Le lien d'installation porte la clé après le #, que le navigateur n'envoie jamais au serveur. */
  function lireLien(texte) {
    const m = String(texte || '').match(/#(.+)$/);
    if (!m) return null;
    const p = new URLSearchParams(m[1]);
    return p.get('cle') ? { cle: p.get('cle'), qui: p.get('p') } : null;
  }
  function retenir(lien) {
    L.ecrire('cle', lien.cle);
    if (lien.qui) L.ecrire('qui-lien', lien.qui);
  }

  function ecranCle(message) {
    accueil(`<h1>Ouvrez votre lien d’installation</h1>
      <p>${message || 'Ouvrez sur ce téléphone le lien personnel reçu, ou collez-le ici.'}</p>
      <input class="champ" id="lien-cle" type="url" placeholder="Coller le lien" autocapitalize="none" autocorrect="off" enterkeyhint="go" style="background:var(--surface);box-shadow:var(--ombre)">
      <button class="btn btn-primaire btn-plein" id="valider-cle">Continuer</button>
      ${navigator.clipboard && navigator.clipboard.readText ? '<button class="btn btn-sec btn-plein" id="coller-cle">Coller depuis le presse-papiers</button>' : ''}`);
    const valider = (v) => {
      const l = lireLien(v);
      if (!l) { ecranCle('Ce n’est pas le bon lien : il se termine par « #cle=… ».'); return; }
      retenir(l);
      L.effacer('mdp');
      amorcer();
    };
    document.getElementById('valider-cle').onclick = () => valider(document.getElementById('lien-cle').value);
    document.getElementById('coller-cle')?.addEventListener('click', async () => { try { valider(await navigator.clipboard.readText()); } catch { /* refusé */ } });
  }

  function ecranMdp(message) {
    accueil(`<h1>Mot de passe</h1>
      <p${message ? ' class="erreur-mdp"' : ''}>${message || 'Une seule fois sur ce téléphone.'}</p>
      <form id="form-mdp" style="display:contents">
        <input type="text" name="username" value="Soonstep Comm" autocomplete="username" hidden>
        <input class="champ" id="mdp" type="password" autocomplete="current-password" autocapitalize="none" autocorrect="off" enterkeyhint="go" placeholder="Mot de passe" style="background:var(--surface);box-shadow:var(--ombre)">
        <button class="btn btn-primaire btn-plein" id="valider-mdp" type="submit">Ouvrir</button>
      </form>
      <button class="btn btn-sec btn-plein" id="autre-lien" type="button">Utiliser un autre lien</button>`);
    const champ = document.getElementById('mdp');
    document.getElementById('form-mdp').onsubmit = async (e) => {
      e.preventDefault();
      if (!champ.value) return;
      const bouton = document.getElementById('valider-mdp');
      bouton.disabled = true;
      bouton.textContent = 'Ouverture…';
      L.ecrire('mdp', await secretMdp(L.lire('cle', ''), champ.value));
      amorcer(true);
    };
    document.getElementById('autre-lien').onclick = () => { L.effacer('cle'); L.effacer('mdp'); ecranCle(); };
  }

  function executer(code, nom) {
    return new Promise((ok, ko) => {
      const s = document.createElement('script');
      s.src = URL.createObjectURL(new Blob([`${code}\n//# sourceURL=${nom}.js`], { type: 'text/javascript' }));
      s.onload = ok;
      s.onerror = () => ko(new Error(nom));
      document.body.append(s);
    });
  }

  async function amorcer(vientDuMdp = false) {
    const lien = lireLien(location.href);
    if (lien) {
      retenir(lien);
      // Dans Safari, le lien reste affiché : « Sur l'écran d'accueil » l'emporte avec la clé.
      if (autonome()) history.replaceState(null, '', location.pathname);
    }
    const cle = L.lire('cle', null);
    if (!cle) { ecranCle(); return; }
    const secret = L.lire('mdp', null);
    if (!secret) { ecranMdp(); return; }
    try {
      await ouvrir(cle, secret);
    } catch (err) {
      if (err.message === 'cle') {
        L.effacer('mdp');
        ecranMdp(vientDuMdp ? 'Mot de passe incorrect.' : 'Le mot de passe a changé, ou le lien n’est plus à jour.');
        return;
      }
      accueil('<h1>Pas de connexion</h1><p>L’appli a besoin d’internet pour sa première ouverture.</p><button class="btn btn-primaire btn-plein" id="reessayer">Réessayer</button>');
      document.getElementById('reessayer').onclick = () => location.reload();
      return;
    }
    CLE = cle;
    try {
      for (const nom of ['planning', 'promotion', 'sondage', 'offre', 'abonnes', 'app']) await executer(paquet.scripts[nom], nom);
    } catch (err) {
      accueil(`<h1>L’appli n’a pas pu démarrer</h1><p>${String(err.message || err)}</p>`);
    }
  }

  // Apparence : « systeme » suit le téléphone, « clair » et « sombre » l'imposent.
  const COULEURS_BARRE = { clair: '#faf7ff', sombre: '#0f172a' };
  const metasBarre = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => ({ m, media: m.getAttribute('media'), couleur: m.content }));
  function appliquerTheme(theme) {
    const t = theme === 'clair' || theme === 'sombre' ? theme : 'systeme';
    if (t === 'systeme') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    for (const { m, media, couleur } of metasBarre) {
      if (t === 'systeme') { m.setAttribute('media', media); m.content = couleur; } else { m.removeAttribute('media'); m.content = COULEURS_BARRE[t]; }
    }
    L.ecrire('theme', t);
  }
  appliquerTheme(L.lire('theme', 'systeme'));

  window.BASE = { L, appliquerTheme, ouvrir, blob, url, urlPrete, existe, Noyau, paquet: () => paquet, cle: () => CLE };

  // Le manifeste sert à Android (installation, verticale imposée). Sur iPhone, sans lui,
  // « Sur l'écran d'accueil » garde le lien complet, clé comprise.
  if (!(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1))) {
    const l = document.createElement('link');
    l.rel = 'manifest';
    l.href = 'manifest.webmanifest';
    document.head.append(l);
  }
  if ('serviceWorker' in navigator && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', amorcer); else amorcer();
})();
