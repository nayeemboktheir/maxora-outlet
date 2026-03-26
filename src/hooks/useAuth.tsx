import { useState, useEffect, useRef, createContext, useContext } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isAdmin: boolean;
  signUp: (email: string, password: string, fullName: string, phone?: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Cache admin check to avoid redundant queries
const adminCache = new Map<string, { isAdmin: boolean; timestamp: number }>();
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const AUTH_REQUEST_TIMEOUT_MS = 10000;
const ADMIN_ROLE_RETRY_DELAY_MS = 1500;

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

const getAuthStorageKey = () => {
  try {
    const projectRef = new URL(import.meta.env.VITE_SUPABASE_URL).hostname.split('.')[0];
    return `sb-${projectRef}-auth-token`;
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const initializedRef = useRef(false);
  const adminCheckRef = useRef<string | null>(null);
  const adminRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkAdminRole = async (userId: string): Promise<boolean | null> => {
    // Check cache first
    const cached = adminCache.get(userId);
    if (cached && Date.now() - cached.timestamp < ADMIN_CACHE_TTL) {
      setIsAdmin(cached.isAdmin);
      adminCheckRef.current = userId;
      return cached.isAdmin;
    }

    try {
      const roleQueryPromise = (async () =>
        await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', userId)
          .eq('role', 'admin')
          .maybeSingle())();

      const { data, error } = await withTimeout(
        roleQueryPromise,
        AUTH_REQUEST_TIMEOUT_MS,
        'Admin role check timed out'
      );

      if (error) throw error;

      const result = !!data;
      adminCache.set(userId, { isAdmin: result, timestamp: Date.now() });
      adminCheckRef.current = userId;
      setIsAdmin(result);
      return result;
    } catch (err) {
      console.error('Error checking admin role:', err);
      adminCheckRef.current = userId;
      return null;
    }
  };

  useEffect(() => {
    let isMounted = true;

    const clearRetryTimeout = () => {
      if (adminRetryTimeoutRef.current) {
        clearTimeout(adminRetryTimeoutRef.current);
        adminRetryTimeoutRef.current = null;
      }
    };

    const processSession = async (nextSession: Session | null) => {
      if (!isMounted) return;

      setSession(nextSession);
      setUser(nextSession?.user ?? null);

      if (!nextSession?.user) {
        clearRetryTimeout();
        setIsAdmin(false);
        adminCheckRef.current = null;
        return;
      }

      clearRetryTimeout();
      const roleCheckResult = await checkAdminRole(nextSession.user.id);

      if (roleCheckResult === null && isMounted) {
        adminRetryTimeoutRef.current = setTimeout(() => {
          void checkAdminRole(nextSession.user.id);
        }, ADMIN_ROLE_RETRY_DELAY_MS);
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        if (!initializedRef.current) return;
        void processSession(newSession);
      }
    );

    const initializeAuth = async () => {
      try {
        const { data: { session: initialSession } } = await withTimeout(
          supabase.auth.getSession(),
          AUTH_REQUEST_TIMEOUT_MS,
          'Session initialization timed out'
        );

        await processSession(initialSession);
      } catch (error) {
        console.error('Auth initialization failed:', error);

        const authStorageKey = getAuthStorageKey();
        if (authStorageKey) {
          localStorage.removeItem(authStorageKey);
        }

        if (isMounted) {
          setSession(null);
          setUser(null);
          setIsAdmin(false);
          adminCheckRef.current = null;
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
          initializedRef.current = true;
        }
      }
    };

    void initializeAuth();

    return () => {
      isMounted = false;
      clearRetryTimeout();
      subscription.unsubscribe();
    };
  }, []);

  const signUp = async (email: string, password: string, fullName: string, phone?: string) => {
    const redirectUrl = `${window.location.origin}/`;

    try {
      const { error } = await withTimeout(
        supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectUrl,
            data: {
              full_name: fullName,
              phone: phone || null,
            }
          }
        }),
        AUTH_REQUEST_TIMEOUT_MS,
        'Sign up request timed out'
      );

      return { error: error as Error | null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signIn = async (email: string, password: string) => {
    // Clear admin cache so fresh role check happens after login
    adminCache.clear();

    try {
      const { error } = await withTimeout(
        supabase.auth.signInWithPassword({
          email,
          password,
        }),
        AUTH_REQUEST_TIMEOUT_MS,
        'Login request timed out. Please try again.'
      );

      return { error: error as Error | null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signOut = async () => {
    adminCache.clear();
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setIsAdmin(false);
  };

  return (
    <AuthContext.Provider value={{
      user,
      session,
      isLoading,
      isAdmin,
      signUp,
      signIn,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
