export type ProxyType = "http" | "https" | "socks5" | "socks4";

/**
 * Input for `POST /proxies` (object form). `password` is PLAINTEXT on input; the daemon stores it
 * in the secrets table and writes `password_ref` on the stored document.
 */
export interface ProxyCreate {
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  change_ip_url?: string;
  session_pattern?: string;
  provider?: string;
  /** socks5 only; defaults to `false`. */
  udp?: boolean;
  tags?: string[];
  notes?: string;
}
