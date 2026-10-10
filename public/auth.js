// public/auth.js
// Supabase Authentication & Session Management for Buzy SI

const SUPABASE_URL = "https://jsrxiehmnqatqoyqopun.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcnhpZWhtbnFhdHFveXFvcHVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNzUwMjAsImV4cCI6MjEwNjc1MTAyMH0.7EjFx7i_ajnKNO42npTwiWubpwH1viu3GnA3yhGA_qg";

// Initialize Supabase browser client
let sb = null;
if (window.supabase) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

window.BuzyAuth = {
  client: sb,

  async getSession() {
    if (!sb) return null;
    const { data: { session } } = await sb.auth.getSession();
    return session;
  },

  async getUser() {
    if (!sb) return null;
    const { data: { user } } = await sb.auth.getUser();
    return user;
  },

  async requireAuth(redirectTo = "/account.html?mode=login") {
    const session = await this.getSession();
    if (!session) {
      window.location.href = redirectTo;
      return null;
    }
    return session.user;
  },

  async signInWithEmail(email, password) {
    if (!sb) throw new Error("Supabase auth client not ready");
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signUpWithEmail(email, password) {
    if (!sb) throw new Error("Supabase auth client not ready");
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    if (!sb) return;
    await sb.auth.signOut();
    window.location.href = "/";
  },

  onAuthStateChange(callback) {
    if (!sb) return { data: { subscription: { unsubscribe() {} } } };
    return sb.auth.onAuthStateChange(callback);
  }
};
