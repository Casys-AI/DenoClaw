# DenoClaw — Notes & TODOs

## Embedder Ollama Cloud

Ollama Cloud (`api.ollama.com`) ne supporte **pas** le endpoint `/api/embed` — renvoie "unauthorized".
Aucun modèle d'embedding dans leur catalogue (que des LLMs).

**Action :** Retirer `EMBEDDER_PROVIDER=ollama` comme option viable pour Ollama Cloud.
Soit documenter clairement que `ollama` = Ollama **local** uniquement,
soit supprimer le provider ollama pour l'embedding et ne garder que `fastembed` + `none`.

**Workaround actuel :** `EMBEDDER_PROVIDER=fastembed` (ONNX local, ~100MB download au premier lancement).
