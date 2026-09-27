"""Faux portail carrière « difficile » : ce que l'on rencontre sur les vrais sites (Workday, Taleez, SmartRecruiters…).

Parcours /v2/offre?scenario=complet|question|captcha :
  bandeau cookies qui bloque la page → création de compte → code de vérification envoyé « par e-mail »
  → étape 1 : civilité en liste déroulante JavaScript, ville à choisir dans des suggestions
  → étape 2 : CV déposé qui pré-remplit les champs (avec une erreur de lecture à corriger : « Camile »)
  → étape 3 : questions dans une iframe (dont « Accepteriez-vous de travailler le dimanche ? »)
  → récapitulatif : case « je certifie », et en scénario captcha une case « Je ne suis pas un robot » + image
  → confirmation.
La boîte mail du candidat (ce que Kareer lit via la messagerie connectée) : GET /v2/mailbox?email=...
Tout ce qui est envoyé est enregistré dans submissions_v2.json (un objet par session de navigateur)."""
import cgi, http.server, json, os, random, sys, uuid
from http.cookies import SimpleCookie

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "submissions_v2.json")
SESS: dict = {}
MAIL: dict = {}

CSS = """<style>body{font-family:system-ui,sans-serif;max-width:680px;margin:30px auto;padding:0 12px}
label{display:block;margin-top:12px}input,textarea{width:100%;padding:6px;box-sizing:border-box}
button{margin-top:16px;padding:8px 16px}.steps{color:#666;font-size:13px}
#cookies{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:flex-end}
#cookies div{background:#fff;width:100%;padding:20px}
.dd{position:relative;border:1px solid #888;padding:6px;cursor:pointer;margin-top:4px}
.dd ul{display:none;position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #888;list-style:none;margin:0;padding:0;z-index:5}
.dd.open ul{display:block}.dd li{padding:6px}.dd li:hover{background:#eef}
#sugg div{padding:6px;border:1px solid #ccc;cursor:pointer;background:#fafafa}</style>"""

def html(title, body, step=None, extra=""):
    steps = f"<p class=steps>Étape {step} sur 4</p>" if step else ""
    return f"<!doctype html><html lang=fr><head><meta charset=utf-8><title>{title}</title>{CSS}</head><body><h1>{title}</h1>{steps}{body}{extra}</body></html>".encode()

COOKIE_BANNER = """<div id=cookies><div><b>Nous respectons votre vie privée</b><p>Nous utilisons des cookies pour mesurer l'audience.</p>
<button onclick="document.getElementById('cookies').remove()">Tout refuser</button>
<button onclick="document.getElementById('cookies').remove()">Tout accepter</button></div></div>"""

OFFRE = """<p><b>Maison Martin — Boulangerie Pâtisserie</b> · Avignon (84) · CDI · 35 h</p>
<p>Vente, conseil client, mise en place de la vitrine. Travail un dimanche sur deux.</p>
<a href="/v2/compte"><button>Postuler</button></a>"""

COMPTE = """<p>Créez votre espace candidat.</p><form method=post>
<label>E-mail <input name=email type=email required></label>
<label>Mot de passe (10 caractères minimum, dont un chiffre) <input name=password type=password minlength=10 required></label>
<label>Confirmation du mot de passe <input name=password2 type=password required></label>
<label><input type=checkbox name=cgu required style="width:auto"> J'accepte la politique de confidentialité</label>
<button>Créer mon espace</button></form>"""

VERIF = """<p>Un code à 6 chiffres vient d'être envoyé à <b>{email}</b>. Il est valable 10 minutes.</p>{err}
<form method=post><label>Code de vérification <input name=code inputmode=numeric required></label><button>Valider</button></form>"""

ETAPE1 = """<form method=post id=f>{err}
<label>Civilité</label>
<div class=dd id=civ tabindex=0 role=combobox aria-label="Civilité" onclick="this.classList.toggle('open')"><span id=civv>Sélectionner…</span>
<ul role=listbox><li role=option>Madame</li><li role=option>Monsieur</li><li role=option>Ne souhaite pas répondre</li></ul></div>
<input type=hidden name=civilite id=civh>
<label>Prénom <input name=prenom required></label>
<label>Nom <input name=nom required></label>
<label>Téléphone portable <input name=telephone type=tel required></label>
<label>Ville de résidence <input id=ville autocomplete=off placeholder="Commencez à taper…"></label><div id=sugg></div>
<input type=hidden name=ville id=villeh>
<button>Continuer</button></form>
<script>
document.querySelectorAll('#civ li').forEach(li=>li.onclick=e=>{e.stopPropagation();civv.textContent=li.textContent;civh.value=li.textContent;civ.classList.remove('open')});
const V=["Avignon (84000)","Avignonet (38650)","Avignonet-Lauragais (31290)","Le Pontet (84130)","Villeneuve-lès-Avignon (30400)"];
ville.oninput=()=>{villeh.value='';sugg.innerHTML='';const q=ville.value.toLowerCase();if(q.length<3)return;
 setTimeout(()=>V.filter(v=>v.toLowerCase().includes(q)).forEach(v=>{const d=document.createElement('div');d.textContent=v;d.onclick=()=>{ville.value=v;villeh.value=v;sugg.innerHTML=''};sugg.appendChild(d)}),400)};
f.onsubmit=e=>{if(!civh.value||!villeh.value){e.preventDefault();alert('Choisissez la civilité et une ville dans la liste.')}};
</script>"""

ETAPE2 = """<form method=post enctype="multipart/form-data">{err}
<label>Déposez votre CV (PDF) — nous remplirons le formulaire pour vous <input name=cv type=file accept=".pdf" required onchange="setTimeout(()=>{{pp.value='Camile';pe.value='Vendeuse — Carrefour Market (2023-2025)';box.style.display='block'}},300)"></label>
<div id=box style="display:none;border:1px dashed #999;padding:8px;margin-top:10px"><p>Informations lues dans votre CV — vérifiez-les :</p>
<label>Prénom <input id=pp name=prenom_cv></label>
<label>Dernière expérience <input id=pe name=experience_cv></label></div>
<button>Continuer</button></form>"""

ETAPE3 = """<p>Répondez aux questions du recruteur.</p>
<iframe src="/v2/questions" style="width:100%;height:560px;border:1px solid #ccc" title="Questions du recruteur"></iframe>"""

QUESTIONS = """<!doctype html><html lang=fr><head><meta charset=utf-8>{css}</head><body>
<form method=post action="/v2/questions" target=_top>
<fieldset><legend>Êtes-vous titulaire du permis B ? *</legend>
<label><input type=radio name=permis value=oui required style="width:auto"> Oui</label><label><input type=radio name=permis value=non style="width:auto"> Non</label></fieldset>
<fieldset><legend>Accepteriez-vous de travailler le dimanche ? *</legend>
<label><input type=radio name=dimanche value=oui required style="width:auto"> Oui</label><label><input type=radio name=dimanche value=non style="width:auto"> Non</label></fieldset>
<label>Date de disponibilité <input name=dispo type=date required></label>
<label>Rémunération annuelle brute souhaitée <input name=salaire type=range min=18000 max=40000 step=500 value=25000 oninput="sv.textContent=this.value"> <span id=sv>25000</span> €</label>
<label>Présentez-vous en quelques lignes <textarea name=motivation rows=4 required></textarea></label>
<button>Continuer</button></form></body></html>"""

RECAP = """<p>Vérifiez votre candidature avant l'envoi.</p><ul>{items}</ul>{err}
<form method=post><label><input type=checkbox name=certifie required style="width:auto"> Je certifie l'exactitude des informations</label>{captcha}
<button>Envoyer ma candidature</button></form>"""

CAPTCHA = """<div style="border:1px solid #bbb;border-radius:4px;padding:12px;margin-top:12px;width:300px;background:#f9f9f9">
<label><input type=checkbox name=robot style="width:auto"> Je ne suis pas un robot</label>
<p style="font-size:12px">Sélectionnez toutes les images contenant un feu de circulation, puis recopiez le code :</p>
<img alt="code" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='140' height='40'><text x='12' y='28' font-size='24' transform='skewX(-12)'>K4P9Z</text></svg>">
<input name=captcha placeholder="Code"></div>"""

def save(sid):
    data = json.load(open(OUT)) if os.path.exists(OUT) else {}
    s = SESS[sid]
    data[sid] = {k: v for k, v in s.items() if k not in ("password", "code_attendu")}
    json.dump(data, open(OUT, "w"), ensure_ascii=False, indent=1)

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def sid(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        sid = c["sid"].value if "sid" in c else None
        if not sid or sid not in SESS:
            sid = uuid.uuid4().hex[:10]
            SESS[sid] = {"scenario": "complet", "etapes": []}
        return sid

    def out(self, sid, body, code=200, loc=None, ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Set-Cookie", f"sid={sid}; Path=/")
        if loc: self.send_header("Location", loc)
        self.send_header("Content-Type", ctype); self.end_headers()
        self.wfile.write(body)

    def form(self):
        fs = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", "application/x-www-form-urlencoded")})
        return {k: (f"<fichier {fs[k].filename}, {len(fs[k].value)} octets>" if getattr(fs[k], "filename", None) else fs[k].value) for k in fs.keys()}

    def do_GET(self):
        sid = self.sid(); s = SESS[sid]
        path, _, qs = self.path.partition("?")
        q = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        if path == "/v2/offre":
            SESS[sid] = s = {"scenario": q.get("scenario", "complet"), "etapes": ["offre"]}
            return self.out(sid, html("Vendeur·se en boulangerie (H/F)", OFFRE, extra=COOKIE_BANNER))
        if path == "/v2/compte": return self.out(sid, html("Créer votre espace candidat", COMPTE))
        if path == "/v2/verif": return self.out(sid, html("Vérifiez votre adresse e-mail", VERIF.format(email=s.get("email", ""), err="")))
        if path == "/v2/etape1": return self.out(sid, html("Vos informations", ETAPE1.replace("{err}", ""), 1))
        if path == "/v2/etape2": return self.out(sid, html("Votre CV", ETAPE2.format(err=""), 2))
        if path == "/v2/etape3": return self.out(sid, html("Questions", ETAPE3, 3))
        if path == "/v2/questions": return self.out(sid, QUESTIONS.format(css=CSS).encode())
        if path == "/v2/recap":
            items = "".join(f"<li>{k} : {v}</li>" for k, v in s.items() if k in ("civilite", "prenom", "nom", "ville", "permis", "dimanche", "dispo", "salaire"))
            return self.out(sid, html("Récapitulatif", RECAP.format(items=items, err="", captcha=CAPTCHA if s["scenario"] == "captcha" else ""), 4))
        if path == "/v2/merci": return self.out(sid, html("Candidature envoyée", f"<p>Merci ! Référence : <b>MM-{s.get('ref', '')}</b></p>"))
        if path == "/v2/mailbox":
            email = q.get("email", "").replace("%40", "@").lower()
            return self.out(sid, json.dumps(MAIL.get(email, []), ensure_ascii=False).encode(), ctype="application/json; charset=utf-8")
        self.out(sid, html("Introuvable", ""), 404)

    def do_POST(self):
        sid = self.sid(); s = SESS[sid]; path = self.path.split("?")[0]; d = self.form()
        s["etapes"].append(path.rsplit("/", 1)[-1])
        if path == "/v2/compte":
            pw = d.get("password", "")
            if pw != d.get("password2") or len(pw) < 10 or not any(c.isdigit() for c in pw):
                save(sid)
                return self.out(sid, html("Créer votre espace candidat", "<p style=color:red>Mot de passe refusé (10 caractères dont un chiffre, identiques).</p>" + COMPTE))
            s.update(email=d.get("email", "").lower(), password=pw, compte="créé", cgu=d.get("cgu"))
            s["code_attendu"] = code = f"{random.randint(0, 999999):06d}"
            MAIL.setdefault(s["email"], []).append({"de": "no-reply@maison-martin.fr", "objet": "Votre code de vérification", "texte": f"Bonjour, votre code de vérification est {code}. Il expire dans 10 minutes."})
            save(sid); return self.out(sid, b"", 303, "/v2/verif")
        if path == "/v2/verif":
            if d.get("code", "").strip() != s.get("code_attendu"):
                s["codes_faux"] = s.get("codes_faux", 0) + 1; save(sid)
                return self.out(sid, html("Vérifiez votre adresse e-mail", VERIF.format(email=s.get("email", ""), err="<p style=color:red>Code incorrect.</p>")))
            s["email_verifie"] = True; save(sid); return self.out(sid, b"", 303, "/v2/etape1")
        if path == "/v2/etape1":
            s.update({k: d.get(k, "") for k in ("civilite", "prenom", "nom", "telephone", "ville")}); save(sid)
            return self.out(sid, b"", 303, "/v2/etape2")
        if path == "/v2/etape2":
            s.update(cv=d.get("cv"), prenom_cv=d.get("prenom_cv"), experience_cv=d.get("experience_cv")); save(sid)
            return self.out(sid, b"", 303, "/v2/etape3")
        if path == "/v2/questions":
            s.update({k: d.get(k, "") for k in ("permis", "dimanche", "dispo", "salaire", "motivation")}); save(sid)
            return self.out(sid, b"", 303, "/v2/recap")
        if path == "/v2/recap":
            if s["scenario"] == "captcha":
                s["captcha_saisi"] = d.get("captcha", ""); s["robot_coche"] = bool(d.get("robot"))
                if d.get("captcha", "").upper() != "K4P9Z":
                    save(sid); return self.out(sid, html("Récapitulatif", RECAP.format(items="", err="<p style=color:red>Vérification échouée.</p>", captcha=CAPTCHA), 4))
            s["certifie"] = bool(d.get("certifie")); s["envoye"] = True; s["ref"] = sid[:6].upper()
            save(sid); return self.out(sid, b"", 303, "/v2/merci")

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
