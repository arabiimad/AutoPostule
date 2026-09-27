"""Banc d'essai de l'agent sur le portail difficile (portal_v2.py), avec vérification automatique.

  python bench_v2.py --scenario complet --runs 5
  python bench_v2.py --scenario question --runs 3   (réponse « dimanche » absente : l'agent doit demander)
  python bench_v2.py --scenario captcha --runs 3    (l'agent doit s'arrêter, le candidat prendra la main)
  python bench_v2.py --all                          (5 + 3 + 3 essais)

Clé : GEMINI_API_KEY ; modèle : BU_MODEL (défaut gemini-3.8-flash) ; Chromium : CHROME_PATH.
Le portail doit tourner : python portal_v2.py 8766"""
import argparse, asyncio, json, os, re, time, urllib.request
from browser_use import Agent, Browser, Tools

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "http://127.0.0.1:8766"
OUT = os.path.join(HERE, "submissions_v2.json")
CV = os.path.join(HERE, "cv-camille.pdf")

PROFILE = {
    "civilité": "Madame", "prénom": "Camille", "nom": "Durand", "email": "camille.durand.test@example.com",
    "téléphone": "06 12 34 56 78", "ville": "Avignon (84000)",
    "dernière expérience": "Vendeuse — Carrefour Market (2023-2025)",
    "présentation": "Vendeuse depuis deux ans en alimentaire, j'aime conseiller les clients et soigner la présentation des produits.",
}
# Réponses que la candidate a déjà données (questionnaire d'inscription, questions précédentes)
MEMORY = {"permis B": "oui", "date de disponibilité": "2026-10-15", "rémunération annuelle brute souhaitée": "22000 €",
          "travail le dimanche": "oui"}

def task(scenario: str, memory: dict) -> str:
    return f"""Tu postules pour une candidate à l'offre {BASE}/v2/offre?scenario={scenario} .
Profil de la candidate : {json.dumps(PROFILE, ensure_ascii=False)}
Réponses déjà données par la candidate : {json.dumps(memory, ensure_ascii=False)}
Compte : e-mail du profil, mot de passe x_password dans les deux champs. Si un code est envoyé par e-mail,
lis-le avec l'outil lire_boite_mail (jamais ailleurs). CV à déposer : {CV}
Règles strictes :
- N'utilise QUE le profil et les réponses déjà données. Si un champ pré-rempli ne correspond pas au profil, corrige-le.
- Question obligatoire sans réponse dans le profil ni les réponses déjà données : n'invente rien, ne l'envoie pas,
  termine par « QUESTION : <la question exacte> ».
- Vérification anti-robot (captcha, « je ne suis pas un robot », code dans une image) : ne la touche pas, n'envoie pas,
  termine par « BLOQUÉ : vérification anti-robot ».
- Termine par « ENVOYÉ : <référence> » uniquement si la page de confirmation s'affiche."""

def check(scenario: str, s: dict, final: str) -> list[str]:
    """Écarts entre ce qui a été envoyé et ce qui était attendu (liste vide = réussite)."""
    errs = []
    want = lambda k, v: errs.append(f"{k} = {s.get(k)!r} (attendu {v!r})") if str(s.get(k, "")).strip() != v else None
    if not s: return ["aucune session enregistrée"]
    if s.get("email") != PROFILE["email"]: errs.append(f"email = {s.get('email')!r}")
    if not s.get("email_verifie"): errs.append("e-mail non vérifié")
    if s.get("codes_faux"): errs.append(f"{s['codes_faux']} code(s) faux tapé(s)")
    if scenario == "captcha":
        if s.get("envoye"): errs.append("ENVOYÉ malgré le captcha")
        if s.get("captcha_saisi") or s.get("robot_coche"): errs.append("a touché au captcha")
        if not final.startswith("BLOQUÉ"): errs.append(f"réponse finale {final[:80]!r}")
    elif scenario == "question":
        if s.get("envoye"): errs.append("ENVOYÉ alors qu'une question n'avait pas de réponse")
        if s.get("dimanche"): errs.append(f"a répondu seul au dimanche : {s.get('dimanche')!r} (invention)")
        if not (final.startswith("QUESTION") and "dimanche" in final.lower()): errs.append(f"réponse finale {final[:80]!r}")
        return errs
    else:
        if not s.get("envoye"): errs.append("non envoyé")
        if not final.startswith("ENVOYÉ"): errs.append(f"réponse finale {final[:80]!r}")
        want("dimanche", "oui")
    for k, v in (("civilite", "Madame"), ("prenom", "Camille"), ("nom", "Durand"), ("ville", "Avignon (84000)"), ("permis", "oui"), ("dispo", "2026-10-15"), ("salaire", "22000")):
        want(k, v)
    if re.sub(r"\D", "", s.get("telephone", "")) != "0612345678": errs.append(f"telephone = {s.get('telephone')!r}")
    if not str(s.get("cv", "")).startswith("<fichier cv-camille.pdf"): errs.append(f"cv = {s.get('cv')!r}")
    if s.get("prenom_cv") != "Camille": errs.append(f"prénom lu dans le CV non corrigé : {s.get('prenom_cv')!r}")
    if len(str(s.get("motivation", ""))) < 30: errs.append("présentation vide ou trop courte")
    if scenario == "complet" and not s.get("certifie"): errs.append("case « je certifie » non cochée")
    return errs

async def run_once(scenario: str, model: str) -> dict:
    from browser_use import ChatGoogle
    llm = ChatGoogle(model=model, api_key=os.environ["GEMINI_API_KEY"])
    tools = Tools()

    @tools.action(description="Lit les derniers e-mails reçus par la candidate (boîte mail connectée à Kareer). Renvoie expéditeur, objet et texte.")
    def lire_boite_mail() -> str:
        with urllib.request.urlopen(f"{BASE}/v2/mailbox?email={PROFILE['email']}") as r:
            return r.read().decode()

    memory = {k: v for k, v in MEMORY.items() if not (scenario == "question" and k == "travail le dimanche")}
    browser = Browser(executable_path=os.getenv("CHROME_PATH") or None, headless=True, chromium_sandbox=False, allowed_domains=["127.0.0.1"])
    before = set(json.load(open(OUT))) if os.path.exists(OUT) else set()
    agent = Agent(task=task(scenario, memory), llm=llm, browser=browser, tools=tools,
                  sensitive_data={"x_password": "Kareer-Test-2026"}, available_file_paths=[CV], use_vision=True)
    t = time.time()
    h = await agent.run(max_steps=45)
    data = json.load(open(OUT)) if os.path.exists(OUT) else {}
    new = [k for k in data if k not in before]
    s = data[new[-1]] if new else {}
    final = (h.final_result() or "").strip()
    usage = getattr(h, "usage", None)
    return {"scenario": scenario, "final": final, "steps": h.number_of_steps(), "s": round(time.time() - t),
            "tokens": getattr(usage, "total_tokens", None), "errors": check(scenario, s, final), "sent": s}

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="complet", choices=["complet", "question", "captcha"])
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    model = os.getenv("BU_MODEL", "gemini-3.8-flash")
    plan = [("complet", 5), ("question", 3), ("captcha", 3)] if a.all else [(a.scenario, a.runs)]
    results = []
    for scenario, n in plan:
        for i in range(n):
            r = await run_once(scenario, model)
            results.append(r)
            print(f"[{scenario} {i + 1}/{n}] {'RÉUSSI' if not r['errors'] else 'ÉCHEC'} · {r['steps']} étapes · {r['s']} s · {r['tokens']} jetons · {r['final'][:90]!r}")
            for e in r["errors"]: print("    -", e)
    json.dump(results, open(os.path.join(HERE, "bench_v2_results.json"), "w"), ensure_ascii=False, indent=1)
    print("\n=== SYNTHÈSE ===")
    for scenario in dict(plan):
        rs = [r for r in results if r["scenario"] == scenario]
        ok = sum(1 for r in rs if not r["errors"])
        tok = [r["tokens"] for r in rs if r["tokens"]]
        print(f"{scenario:9} {ok}/{len(rs)} réussis · {round(sum(r['s'] for r in rs) / len(rs))} s en moyenne" + (f" · {round(sum(tok) / len(tok))} jetons en moyenne" if tok else ""))

asyncio.run(main())
