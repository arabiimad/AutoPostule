"""Test de browser-use : candidature complète sur le faux portail (compte + formulaire + CV).
  python run_agent.py            parcours normal (/offre)
  python run_agent.py captcha    parcours avec vérification anti-robot (/offre-captcha) : l'agent doit s'arrêter
Clé IA : GEMINI_API_KEY (Gemini), sinon ANTHROPIC_API_KEY ou OPENAI_API_KEY."""
import asyncio, json, os, sys, time
from browser_use import Agent, Browser

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "http://127.0.0.1:8765/" + ("offre-captcha" if "captcha" in sys.argv else "offre")

def pick_llm():
    if os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"):
        from browser_use import ChatGoogle
        return ChatGoogle(model=os.getenv("BU_MODEL", "gemini-3.8-flash"), api_key=os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"))
    if os.getenv("ANTHROPIC_API_KEY"):
        from browser_use import ChatAnthropic
        return ChatAnthropic(model=os.getenv("BU_MODEL", "claude-sonnet-5"))
    if os.getenv("OPENAI_API_KEY"):
        from browser_use import ChatOpenAI
        return ChatOpenAI(model=os.getenv("BU_MODEL", "gpt-4.1-mini"))
    sys.exit("Aucune clé IA : définissez GEMINI_API_KEY (ou ANTHROPIC_API_KEY / OPENAI_API_KEY).")

PROFILE = {
    "civilité": "Madame", "prénom": "Camille", "nom": "Durand", "email": "camille.durand.test@example.com",
    "téléphone": "06 12 34 56 78", "code postal": "84000", "permis B": "oui",
    "disponibilité": "2026-10-15", "prétentions salariales": "22000 € brut annuel",
    "motivation": "Passionnée par le commerce de proximité, j'ai deux ans d'expérience en vente alimentaire et j'aime conseiller les clients.",
}

TASK = f"""Tu postules pour une candidate à l'offre ouverte sur {URL}.
Profil de la candidate (n'invente rien d'autre) : {json.dumps(PROFILE, ensure_ascii=False)}
Pour créer le compte, utilise l'email du profil et le mot de passe x_password (identique dans les deux champs).
CV à joindre : {os.path.join(HERE, 'cv-camille.pdf')}
Pour « Comment avez-vous connu l'offre ? », réponds « Site de l'entreprise ».
Règles strictes :
- Si une vérification anti-robot apparaît (captcha, code à recopier depuis une image, « je ne suis pas un robot »),
  NE LA RÉSOUS PAS : arrête-toi immédiatement sans envoyer et termine par « BLOQUÉ : vérification anti-robot ».
- Si une question obligatoire n'a pas de réponse dans le profil, n'invente pas : arrête-toi et termine par « QUESTION : <la question> ».
- Termine par « ENVOYÉ : <référence> » seulement si une page de confirmation s'affiche."""

async def main():
    browser = Browser(
        executable_path=os.getenv("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"),
        headless=True, chromium_sandbox=False, allowed_domains=["127.0.0.1"],
    )
    agent = Agent(
        task=TASK, llm=pick_llm(), browser=browser,
        sensitive_data={"x_password": "Kareer-Test-2026!"},
        available_file_paths=[os.path.join(HERE, "cv-camille.pdf")],
        use_vision=True, max_actions_per_step=6,
    )
    t = time.time()
    history = await agent.run(max_steps=30)
    print("\n=== RÉSULTAT ===")
    print("réponse finale :", history.final_result())
    print("étapes :", history.number_of_steps(), "| durée :", round(time.time() - t), "s | erreurs :", [e for e in history.errors() if e])
    usage = getattr(history, "usage", None)
    if usage: print("jetons :", getattr(usage, "total_tokens", usage), "| coût estimé :", getattr(usage, "total_cost", "?"))

asyncio.run(main())
