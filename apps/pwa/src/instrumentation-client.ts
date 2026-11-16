import { z } from "zod";

// O Zod 4 decide usar JIT sondando `new Function("")` quando cada schema de objeto é criado.
// A CSP da PWA não permite `eval` (e não deve), então a sonda é bloqueada e o navegador reporta
// uma violação `script-src` em TODO carregamento (POST /api/csp-report), o que também reprova o
// smoke de produção (que proíbe escritas). `jitless` desliga o JIT e pula a sonda por completo.
// Este arquivo roda antes do código do app, ou seja, antes de qualquer schema ser construído.
z.config({ jitless: true });
