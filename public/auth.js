// public/auth.js
// Supabase Authentication & Session Management for Buzy SI

const SUPABASE_URL = "https://jsrxiehmnqatqoyqopun.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzcnhpZWhtbnFhdHFveXFvcHVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExNzUwMjAsImV4cCI6MjEwNjc1MTAyMH0.7EjFx7i_ajnKNO42npTwiWubpwH1viu3GnA3yhGA_qg";

// Shared cookie storage helper across root domain (.buzy.si)
const isCustomDomain = typeof location !== "undefined" && location.hostname.endsWith("buzy.si");
const cookieDomain = isCustomDomain ? ".buzy.si" : undefined;

// Safe cookie + localStorage adapter
const safeStorage = {
  getItem: (key) => {
    try {
      const localVal = localStorage.getItem(key);
      if (localVal) return localVal;
      const match = document.cookie.match(new RegExp("(^| )" + key + "=([^;]+)"));
      if (match) {
        const decoded = decodeURIComponent(match[2]);
        if (decoded.startsWith("{") && !decoded.endsWith("}")) return null;
        return decoded;
      }
    } catch (e) {
      console.warn("[BuzyAuth] storage.getItem error:", e);
    }
    return null;
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
      // Only set cookie if within safe boundary to prevent browser 4096-byte truncation
      if (value && value.length < 3500) {
        const domainStr = cookieDomain ? `; domain=${cookieDomain}` : "";
        document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=2592000; SameSite=Lax${domainStr}`;
      }
    } catch (e) {
      console.warn("[BuzyAuth] storage.setItem error:", e);
    }
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key);
      const domainStr = cookieDomain ? `; domain=${cookieDomain}` : "";
      document.cookie = `${key}=; path=/; max-age=0; SameSite=Lax${domainStr}`;
    } catch (e) {
      console.warn("[BuzyAuth] storage.removeItem error:", e);
    }
  },
};

// Initialize Supabase browser client
let sb = null;
if (typeof window !== "undefined" && window.supabase) {
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: safeStorage,
      },
    });
  } catch (err) {
    console.error("[BuzyAuth] Failed to initialize Supabase client:", err);
  }
}

window.BuzyAuth = {
  client: sb,

  async getSession() {
    if (!sb) return null;
    try {
      const { data: { session }, error } = await sb.auth.getSession();
      if (error) throw error;
      return session;
    } catch (err) {
      console.warn("[BuzyAuth] getSession warning:", err);
      return null;
    }
  },

  async getUser() {
    if (!sb) return null;
    try {
      const { data: { user }, error } = await sb.auth.getUser();
      if (error) throw error;
      return user;
    } catch (err) {
      console.warn("[BuzyAuth] getUser warning:", err);
      return null;
    }
  },

  async requireAuth(redirectTo = "/account?mode=login") {
    const session = await this.getSession();
    if (!session) {
      window.location.href = redirectTo;
      return null;
    }
    return session.user;
  },

  async signInWithEmail(email, password) {
    if (!sb) throw new Error("Authentication service is temporarily unavailable.");
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signUpWithEmail(email, password) {
    if (!sb) throw new Error("Authentication service is temporarily unavailable.");
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    if (!sb) return;
    try {
      await sb.auth.signOut();
    } catch (e) {}
    window.location.href = "/";
  },

  onAuthStateChange(callback) {
    if (!sb) return { data: { subscription: { unsubscribe() {} } } };
    return sb.auth.onAuthStateChange(callback);
  }
};
