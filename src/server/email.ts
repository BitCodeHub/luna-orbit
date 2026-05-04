/**
 * Email sender — pluggable abstraction.
 *
 * Two providers shipped in v0.4.1:
 *
 *   "console" (default for self-host) — prints the email to stdout. No
 *   external infra required. The verification + reset links are
 *   discoverable in the server log.
 *
 *   "smtp"    — wires to any SMTP server via env vars. Used for real
 *   SaaS deployments. Falls back to "console" if SMTP_HOST is missing.
 *
 * Future: SendGrid / Postmark / Resend providers when there's demand.
 *
 * Email verification + password-reset both use this module — keeping the
 * sender swappable means tests + self-hosters get the same code path
 * as production.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type EmailProvider = "console" | "smtp";

let _transport: { send(m: EmailMessage): Promise<void> } | null = null;

function buildTransport(): { send(m: EmailMessage): Promise<void> } {
  const provider: EmailProvider = (process.env.LUNA_ORBIT_EMAIL_PROVIDER as EmailProvider | undefined) ?? "console";
  if (provider === "smtp" && process.env.LUNA_ORBIT_SMTP_HOST) {
    // Lazy require so installing without the optional `nodemailer` dep is fine.
    // (nodemailer is intentionally NOT a hard dep of luna-orbit — it adds 5MB
    // for a feature most self-hosters don't use. Install it if you set
    // LUNA_ORBIT_EMAIL_PROVIDER=smtp and the env var below.)
    type NM = { createTransport: (opts: unknown) => { sendMail: (m: unknown) => Promise<void> } };
    return {
      async send(m) {
        // nodemailer is intentionally NOT a hard dep. Self-host with the default
        // console provider needs no email infra; production wires SMTP and
        // `npm i nodemailer` separately.
        let nm: NM;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          nm = (await (Function('m', 'return import(m)')("nodemailer"))) as NM;
        } catch {
          console.warn("[email] LUNA_ORBIT_EMAIL_PROVIDER=smtp but `nodemailer` is not installed. Run `npm i nodemailer`. Falling back to console.");
          return consoleProvider().send(m);
        }
        const tx = nm.createTransport({
          host: process.env.LUNA_ORBIT_SMTP_HOST!,
          port: Number(process.env.LUNA_ORBIT_SMTP_PORT ?? "587"),
          secure: process.env.LUNA_ORBIT_SMTP_SECURE === "true",
          auth: process.env.LUNA_ORBIT_SMTP_USER ? {
            user: process.env.LUNA_ORBIT_SMTP_USER,
            pass: process.env.LUNA_ORBIT_SMTP_PASS,
          } : undefined,
        });
        await tx.sendMail({
          from: process.env.LUNA_ORBIT_EMAIL_FROM ?? "Luna Orbit <noreply@luna-orbit.local>",
          to: m.to, subject: m.subject, text: m.text, html: m.html,
        });
      },
    };
  }
  return consoleProvider();
}

function consoleProvider() {
  return {
    async send(m: EmailMessage): Promise<void> {
      const banner = "─".repeat(60);
      console.log(`\n${banner}\n[email · console] ${m.subject}\n${banner}\n  to: ${m.to}\n\n${m.text}\n${banner}\n`);
    },
  };
}

export async function sendEmail(m: EmailMessage): Promise<void> {
  if (!_transport) _transport = buildTransport();
  return _transport.send(m);
}
