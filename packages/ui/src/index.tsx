import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

type AppShellProps = {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
};

type FieldProps = {
  label: string;
  children: ReactNode;
};

type SummaryBlockProps = {
  label: string;
  value: ReactNode;
};

type ResultCardProps = {
  title: string;
  children: ReactNode;
};

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function AppShell({ eyebrow, title, description, children }: AppShellProps) {
  return (
    <main className="ira-page-shell">
      <section className="ira-hero-card">
        <p className="ira-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="ira-hero-copy">{description}</p>
      </section>
      {children}
    </main>
  );
}

export function Panel({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("ira-panel", className)}>
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

export function Field({ label, children }: FieldProps) {
  return (
    <label className="ira-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("ira-input", props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("ira-textarea", props.className)} />;
}

export function PrimaryButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={cx("ira-button", props.className)} />;
}

export function SummaryBlock({ label, value }: SummaryBlockProps) {
  return (
    <div className="ira-summary-block">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ResultCard({ title, children }: ResultCardProps) {
  return (
    <div className="ira-result-card">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function ErrorBanner({ children }: { children: ReactNode }) {
  return <p className="ira-error-banner">{children}</p>;
}

export function PlaceholderCopy({ children }: { children: ReactNode }) {
  return <p className="ira-placeholder-copy">{children}</p>;
}
