import {createAuthClient} from '@neondatabase/auth';
import {SupabaseAuthAdapter} from '@neondatabase/auth/vanilla/adapters';
window.TicketlineNeonAuth=createAuthClient(NEON_AUTH_URL,{adapter:SupabaseAuthAdapter()});
