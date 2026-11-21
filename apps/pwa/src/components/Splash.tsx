/**
 * Splash — PWA startup screen (item premium 3).
 *
 * Mascot 72x72 centered over #0B0F0E with a subtle spring, check drawing
 * (stroke-dashoffset) and "Meu Ted" + "Tudo em dia." in #E8EFEA.
 * CSS animation only (no heavy JS); decorative motion honors
 * prefers-reduced-motion via .splash-* classes. Used as the standalone
 * loading screen (AuthGate) and safe-area aware.
 */
export function Splash() {
  return (
    <main
      className="flex h-dvh flex-col items-center justify-center gap-5"
      style={{
        backgroundColor: "#0B0F0E",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
      aria-label="Carregando Meu Ted"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/ted-launcher.png"
        alt=""
        aria-hidden="true"
        width={88}
        height={88}
        className="splash-mascot h-[88px] w-[88px] rounded-[22px] object-contain"
      />
      <div className="flex flex-col items-center gap-1">
        <span
          className="text-[22px] font-extrabold tracking-tight"
          style={{ color: "#E8EFEA" }}
        >
          Meu Ted
        </span>
        <span
          className="text-[12px] font-semibold tracking-[0.18em] uppercase"
          style={{ color: "#E8EFEA", opacity: 0.7 }}
        >
          Tudo em dia.
        </span>
      </div>
    </main>
  );
}

export default Splash;
