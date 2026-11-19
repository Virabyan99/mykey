// The page's policy allows no code from text (script-src 'self', P-141).
// zod would otherwise try to compile its object parsers, which the policy
// refuses and reports. This runs before the first parse of any schema.
import { z } from "zod";

z.config({ jitless: true });
