# Test browser-use (agent IA qui remplit un portail carrière)

Faux portail : offre → création de compte → formulaire (civilité, téléphone, code postal, CV PDF,
question « permis B », date, salaire, liste, motivation) → confirmation. Variante avec code anti-robot.

    python3 -m venv .venv && .venv/bin/pip install browser-use
    cd tools/browser-use-test
    python3 site.py &                         # portail sur http://127.0.0.1:8765
    export GEMINI_API_KEY=...  ANONYMIZED_TELEMETRY=false
    .venv/bin/python check_browser.py         # sans IA : le navigateur voit la page
    .venv/bin/python run_agent.py             # parcours complet
    .venv/bin/python run_agent.py captcha     # doit s'arrêter : « BLOQUÉ : vérification anti-robot »
    cat submissions.json                      # ce qui a réellement été envoyé

Chromium : CHROME_PATH (défaut /opt/pw-browsers/chromium-1194/chrome-linux/chrome ; sur ton PC, omets-le
ou mets le chemin de Chrome). Modèle : BU_MODEL (défaut gemini-3.8-flash, le modèle rapide de Kareer).
