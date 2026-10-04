import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  getSupabaseUrl,
  getSupabaseServiceRoleKey,
} from "./config.ts";

export function getAdminClient() {
  return createClient(
    getSupabaseUrl(),
    getSupabaseServiceRoleKey(),
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
