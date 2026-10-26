import {createAuthClient} from '@neondatabase/auth';
import {SupabaseAuthAdapter} from '@neondatabase/auth/vanilla/adapters';
const sdk=createAuthClient(NEON_AUTH_URL,{adapter:SupabaseAuthAdapter()});
window.TicketlineNeonAuth={
 refreshSession:()=>sdk.refreshSession(),
 verifyOtp:params=>sdk.verifyOtp(params),
 // The adapter currently ignores a sendVerificationOtp error response.
 // Keep the native result so rate limits and delivery failures reach the UI.
 signInWithOtp:async({email})=>{try{return await sdk.getBetterAuthInstance().emailOtp.sendVerificationOtp({email,type:'sign-in'});}catch(error){return {error};}},
 signOut:()=>sdk.signOut()
};
