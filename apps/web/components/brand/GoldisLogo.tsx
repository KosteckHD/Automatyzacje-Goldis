import Image from "next/image";

export type GoldisLogoVariant = "login" | "sidebar" | "header";

type GoldisLogoProps = {
  variant: GoldisLogoVariant;
  priority?: boolean;
  className?: string;
};

/** The original supplied artwork is used as-is; the CSS frame trims only its empty margin. */
export function GoldisLogo({ variant, priority = false, className = "" }: GoldisLogoProps) {
  return (
    <span className={`goldis-logo goldis-logo--${variant} ${className}`.trim()}>
      <Image
        src="/brand/goldis-logo.jpg"
        alt="AC Goldis Ubezpieczenia"
        width={1019}
        height={1024}
        priority={priority}
        sizes={variant === "login" ? "390px" : variant === "sidebar" ? "230px" : "140px"}
      />
    </span>
  );
}

