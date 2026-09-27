"""Vérifie sans IA que le navigateur de browser-use démarre et voit le faux portail."""
import asyncio, os
from browser_use import Browser
async def main():
    b = Browser(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless=True, chromium_sandbox=False)
    await b.start()
    await b.navigate_to("http://127.0.0.1:8765/offre")
    state = await b.get_browser_state_summary()
    print("titre :", state.title, "| url :", state.url)
    print("éléments interactifs vus par l'agent :", len(state.dom_state.selector_map))
    print(state.dom_state.llm_representation()[:600])
    await b.kill()
asyncio.run(main())
