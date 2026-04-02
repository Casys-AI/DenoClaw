# Kaku + PML + MCP Apps — synergies exploratoires

Date: 2026-04-01
Status: exploration

## PML → Kaku → MCP Apps pipeline

1. **PML décrit** le plan (workflow tree structuré : sequential, parallel,
   conditional, loop)
2. **Kaku exécute** le plan (events typés à chaque étape)
3. **MCP Apps affiche** l'exécution en temps réel et permet l'interaction

## Plan storage as memory

Les plans exécutés sont persistés comme séquences d'events dans l'EventStore.
Ça donne aux agents une mémoire d'exécution :

- "La dernière fois, l'étape 3 a échoué à cause de X"
- "L'utilisateur a rejeté la confirmation à l'étape 2"
- Replay de toute exécution passée pour debug/audit

Les plans peuvent être indexés pour le semantic recall via MemoryService —
"trouve les plans similaires à cette demande qui ont réussi."

## UI interactive de validation workflow

MCP Apps viewer pour l'exécution de workflows :

- Progression temps réel (events streamés)
- Human-in-the-loop (bouton de confirmation inline sur les nœuds HIL)
- Review du plan avant exécution (arbre complet à approuver)
- Visualisation des branches (conditional/parallel en arbre)
- Audit trail (historique d'events consultable après exécution)

Réutilise l'infra MCP Apps de `@casys/mcp-server` (même pattern `ui://`,
même sandbox iframe, même protocole `postMessage`).

## Confirmation events (ConfirmationRequestEvent)

Documenté dans la spec Kaku kernel. Généralise le privilege elevation /
INPUT_REQUIRED actuel. N'importe quel tool peut demander une confirmation
(boolean ou structurée), le runner suspend, l'UI affiche le prompt, l'humain
répond, le kernel reprend.
