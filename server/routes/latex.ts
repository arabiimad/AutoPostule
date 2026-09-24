import type { Express } from "express";
import { compileLatex, detectLatexCompiler, decodeJpegPhoto, TEMPLATES } from "../latex.ts";
import { isWebPdfAvailable } from "../pdf.ts";

export function registerLatexRoutes(app: Express) {
  // 4 ter. Compilation PDF locale (si pdflatex ou tectonic est installé sur la machine du serveur)
  app.get("/api/latex/templates", (req, res) => res.json({ templates: TEMPLATES }));
  app.get("/api/latex/compiler", async (req, res) => {
    const [c, web] = await Promise.all([detectLatexCompiler(), isWebPdfAvailable()]);
    res.json({ available: !!c, compiler: c?.kind || null, web });
  });
  app.post("/api/latex/compile", async (req, res) => {
    const tex = String(req.body?.latexCode || "");
    // Photo facultative (modèle Photo) : JPEG uniquement, écrite à côté du .tex
    const result = await compileLatex(tex, { photo: decodeJpegPhoto(req.body?.photo) });
    if (result.error === "NO_COMPILER") {
      return res.status(501).json({ success: false, error: "Aucun compilateur LaTeX sur le serveur (installez TeX Live, MiKTeX ou tectonic), ou utilisez Overleaf." });
    }
    if (!result.pdf) {
      return res.status(422).json({ success: false, error: result.error || "Compilation impossible.", log: result.log });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="cv.pdf"');
    return res.send(result.pdf);
  });
}
