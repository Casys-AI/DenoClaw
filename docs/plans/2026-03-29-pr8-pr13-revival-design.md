# Reprise structurée de #8 et #13 — Design

## Contexte

Le lot Codex du 29 mars a produit plusieurs variantes concurrentes. Le noyau retenu et déjà mergé dans `main` est centré sur la clarification des ports runtime/orchestration (`#14`, `#15`) ainsi que deux refactors plus localisés (`#3`, `#5`). Deux PR fermées contenaient néanmoins une substance architecturale qu’il serait dommage de perdre telle quelle :

- **#8** : clarification des frontières entre `shared` et les types réellement métier / bounded-context ;
- **#13** : clarification du vocabulaire canonique autour des task messages et du lifecycle A2A.

Le problème n’était pas l’intention, mais la granularité. Ces changements ont été proposés comme des blobs transversaux alors qu’ils doivent être repris en étapes séquencées, chacune avec une cible claire, des tests verts, et un risque limité.

## Objectif

Sauver **toute la valeur utile** de `#8` et `#13`, mais sous une forme mergable : petite surface par PR, responsabilité unique, compatibilité temporaire assumée, suppression différée des aliases et de l’ambiguïté.

## Décision

La reprise se fait en **trois PRs successives** :

1. **PR A — Shared boundary cleanup**
   - Reprendre l’essence de `#8`.
   - Déplacer hors de `src/shared/types.ts` les types qui ne sont pas des contrats inter-domaines stables.
   - Conserver la compatibilité via ré-exports temporaires si nécessaire.
   - Ne pas modifier la logique runtime, seulement les frontières de modules et les imports.

2. **PR B — Canonical naming and contract compatibility layer**
   - Reprendre la partie conceptuelle de `#13`.
   - Introduire un vocabulaire canonique propre (`initialMessage`, `statusMessage`, `taskMessage`, `continuationMessage`, etc.) sans supprimer immédiatement les anciens noms.
   - Ajouter les helpers/aliases de transition et documenter le glossaire.
   - But : faire émerger le bon contrat sans imposer une migration brutale.

3. **PR C — Call-site migration and ambiguity reduction**
   - Migrer les call sites réels vers les nouveaux noms et helpers.
   - Réduire l’usage des anciens aliases au strict minimum.
   - Ajouter/renforcer les tests qui empêchent les retours en arrière.
   - Reporter la suppression définitive des aliases seulement si la surface devient propre et la diff encore raisonnable.

## Pourquoi cet ordre

Le nettoyage des frontières de `shared` doit passer avant le renommage canonique, parce qu’il clarifie d’abord **où vivent les contrats** avant de clarifier **comment on les nomme**. Si on inverse, on risque de renommer des surfaces dont on n’a pas encore décidé si elles sont partagées ou domain-owned.

Ensuite, le renommage canonique doit être scindé entre **introduction du nouveau langage** et **migration des usages**. Sans cette séparation, on retombe dans le piège du blob : on mélange décision de design, couche de compatibilité, refactor mécanique, tests de garde-fou et doc dans un seul paquet.

## Invariants de design

### Invariant 1 — `shared` n’est pas une poubelle de commodité

`src/shared/*` doit contenir uniquement :
- des contrats stables inter-domaines ;
- des primitives réellement transversales ;
- des types nécessaires à plusieurs contextes sans ownership métier évident.

Dès qu’un type exprime surtout une politique, un état métier ou une préoccupation interne d’un bounded context, il doit vivre dans ce domaine, même si plusieurs fichiers l’importent par commodité.

### Invariant 2 — un renommage conceptuel ne doit pas casser l’intégration

Le renommage des concepts canoniques doit d’abord apparaître comme une **couche de compatibilité explicite**, pas comme une réécriture totale en une PR. Le système doit continuer à compiler et les tests doivent rester verts à chaque étape.

### Invariant 3 — les guards doivent cibler les vrais risques

Les tests d’enforcement sont utiles uniquement s’ils empêchent un retour à une mauvaise frontière ou à une transition sauvage. Ils ne doivent pas devenir des oracles fragiles qui cassent à chaque reformulation cosmétique.

## Portée détaillée

### PR A — Shared boundary cleanup

**Inclure :**
- audit de `src/shared/types.ts` et des barrels `src/shared/mod.ts` ;
- extraction des types clairement agent-owned vers `src/agent/*` ;
- extraction des types clairement orchestration-owned vers `src/orchestration/*` ;
- mise à jour des imports ;
- compatibilité temporaire par ré-export si cela réduit le risque ;
- ajout d’un guard simple pour éviter la réintroduction de types métier dans `shared`.

**Exclure :**
- renommage métier ;
- changement de comportement runtime ;
- réécriture globale des tests hors impact direct.

### PR B — Canonical naming compatibility

**Inclure :**
- glossaire documentaire ;
- nouveaux noms canoniques sur les contrats/aliases ciblés ;
- helpers centralisés d’extraction/résolution ;
- compatibilité explicite avec les anciens champs ;
- tests de compatibilité et de non-régression sur les contrats.

**Exclure :**
- migration massive des call sites ;
- suppression des anciens noms ;
- enforcement trop large basé sur grep fragile si le signal métier n’est pas solide.

### PR C — Canonical migration

**Inclure :**
- migration des call sites runtime/broker/mapping/store/tests ;
- réduction de l’ambiguïté locale ;
- guards ciblés sur les points réellement dangereux ;
- suppression éventuelle d’aliases seulement si la diff reste saine.

**Exclure :**
- nouveaux concepts ;
- refactor latéral non requis ;
- nettoyage esthétique hors scope.

## Risques et mitigations

### Risque 1 — collisions avec `#14/#15`

Le nouveau socle ports/adapters est déjà sur `main`. Toute reprise doit partir de `main` et considérer `#14/#15` comme source de vérité. On ne “ressuscite” pas `#8/#13` ; on en extrait la substance et on la réécrit sur la base actuelle.

**Mitigation :** travailler depuis de nouvelles branches, rebasées proprement sur `origin/main`, avec tests à chaque étape.

### Risque 2 — réexports qui deviennent permanents

Les ré-exports temporaires sont utiles pour dé-risquer PR A, mais ils peuvent vite devenir de la dette si personne ne les retire jamais.

**Mitigation :** marquer explicitement les compat layers comme temporaires dans le code et prévoir leur réduction en PR C si la surface le permet.

### Risque 3 — renommage doctrinal trop large

Un renommage peut vite devenir religieux : trop de fichiers, trop d’aliases, trop de vocabulaire sans gain concret.

**Mitigation :** documenter d’abord, centraliser les helpers, puis migrer uniquement les surfaces dont l’ambiguïté nuit réellement au code.

## Stratégie de test

À chaque PR :
- `deno task test:unit`
- tests ciblés des zones modifiées si possible
- vérification que la couche de compatibilité est réellement utilisée comme prévu

Tests spécifiques :
- **PR A** : import boundary guard + suite unitaire verte
- **PR B** : tests de compatibilité anciens/nouveaux noms + documentation/glossaire alignés
- **PR C** : tests runtime/broker/task mapping adaptés aux nouveaux noms, sans régression comportementale

## Critères d’acceptation

### PR A acceptée si :
- `shared` contient une surface plus étroite et plus défendable ;
- les types métier extraits vivent dans leur domaine ;
- la suite unitaire est verte.

### PR B acceptée si :
- le vocabulaire canonique est explicite et documenté ;
- les nouveaux noms existent sans casser l’existant ;
- les tests prouvent la compatibilité.

### PR C acceptée si :
- les call sites principaux utilisent le langage canonique ;
- l’ambiguïté diminue réellement ;
- la suite unitaire reste verte.

## Recommandation finale

Ne pas rouvrir `#8` et `#13` telles quelles. Les traiter comme des **mines d’idées**, pas comme des patches à réanimer. La bonne stratégie est une reprise volontairement plus étroite, plus ordonnée, et plus disciplinée que le lot initial.
