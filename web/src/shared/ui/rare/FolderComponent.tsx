import React, { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "./utils";
import "./rare.css";

const themes = {
  brand: {
    backFill: "#174098", // Brand Navy
    backInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.35 0",
    backInsetShadow: "inset 0 0 8px 2px rgba(255,255,255,0.35)",
    flapFill: "#02A0EA", // Brand Cyan
    flapFillOpacity: 0.65,
    flapStroke: "#02A0EA",
    flapInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.15 0",
    cardFill: "#FFFFFF",
    cardStroke: "#DCE3EB",
    cardLineFill: "#DFEFFB",
    cardInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0",
  },
  blue: {
    backFill: "#02A0EA",
    backInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.35 0",
    backInsetShadow: "inset 0 0 6px 2px rgba(255,255,255,0.35)",
    flapFill: "#174098",
    flapFillOpacity: 0.45,
    flapStroke: "#2386C9",
    flapInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.12 0",
    cardFill: "#FFFFFF",
    cardStroke: "#E0E0E0",
    cardLineFill: "#E8F5FD",
    cardInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0",
  },
  white: {
    backFill: "#FFFFFF",
    backInsetColor: "0 0 0 0 0.7 0 0 0 0 0.7 0 0 0 0 0.7 0 0 0 0.25 0",
    backInsetShadow: "inset 0 0 6px 2px rgba(178,178,178,0.25)",
    flapFill: "#F7FBFF",
    flapFillOpacity: 0.85,
    flapStroke: "#DCE3EB",
    flapInsetColor: "0 0 0 0 0.6 0 0 0 0 0.6 0 0 0 0 0.6 0 0 0 0.15 0",
    cardFill: "#FFFFFF",
    cardStroke: "#DCE3EB",
    cardLineFill: "#DFEFFB",
    cardInsetColor: "0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.15 0",
  },
} as const;

const sizeScales = {
  xs: 0.38,
  sm: 0.55,
  md: 0.85,
  lg: 1.15,
} as const;

export type FolderComponentProps = Omit<React.ComponentProps<"div">, "color"> & {
  color?: "brand" | "blue" | "white";
  size?: "xs" | "sm" | "md" | "lg";
  label?: string;
};

const BASE_WIDTH = 321;
const BASE_HEIGHT = 270;

const FLAP_PATH =
  "M0 25C0 11.1929 11.1929 0 25 0H136.084C143.044 0 149.689 2.90139 154.42 8.00608L178.08 33.5343C182.811 38.639 189.456 41.5404 196.416 41.5404H296C309.807 41.5404 321 52.7333 321 66.5404V216C321 229.807 309.807 241 296 241H25C11.1929 241 0 229.807 0 216V25Z";

type Theme = (typeof themes)[keyof typeof themes];

const Card = ({ id, theme }: { id: number; theme: Theme }) => {
  const filterId = `filter0_i_card_${id}`;
  return (
    <div data-slot="folder-card">
      <svg
        width="164"
        height="214"
        viewBox="0 0 164 214"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g filter={`url(#${filterId})`}>
          <rect
            width="163.078"
            height="213.262"
            rx="20"
            fill={theme.cardFill}
          />
        </g>
        <rect
          x="0.5"
          y="0.5"
          width="162.078"
          height="212.262"
          rx="19.5"
          stroke={theme.cardStroke}
        />
        <rect
          x="14.1193"
          y="31.2091"
          width="134.84"
          height="11.8892"
          rx="5.94459"
          fill={theme.cardLineFill}
        />
        <rect
          width="64.5183"
          height="5.88276"
          rx="2.94138"
          transform="matrix(1 -0.000409158 0.00201956 0.999998 14.8253 60.9939)"
          fill={theme.cardLineFill}
        />
        <rect
          width="64.5183"
          height="5.88276"
          rx="2.94138"
          transform="matrix(1 -0.000461045 0.00179228 0.999998 84.4303 60.9617)"
          fill={theme.cardLineFill}
        />
        <rect
          width="64.5183"
          height="5.88276"
          rx="2.94138"
          transform="matrix(1 -0.000409158 0.00201956 0.999998 14.8253 74.9939)"
          fill={theme.cardLineFill}
        />
        <rect
          width="64.5183"
          height="5.88276"
          rx="2.94138"
          transform="matrix(1 -0.000461045 0.00179228 0.999998 84.4303 74.9617)"
          fill={theme.cardLineFill}
        />
        <rect
          width="134.123"
          height="5.88276"
          rx="2.94138"
          transform="matrix(1 -0.000435102 0.00190592 0.999998 14.8253 88.9778)"
          fill={theme.cardLineFill}
        />
        <defs>
          <filter
            id={filterId}
            x="-20"
            y="-20"
            width="203.078"
            height="253.262"
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feFlood floodOpacity="0" result="BackgroundImageFix" />
            <feBlend
              mode="normal"
              in="SourceGraphic"
              in2="BackgroundImageFix"
              result="shape"
            />
            <feColorMatrix
              in="SourceAlpha"
              type="matrix"
              values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
              result="hardAlpha"
            />
            <feOffset />
            <feGaussianBlur stdDeviation="2.5" />
            <feComposite
              in2="hardAlpha"
              operator="arithmetic"
              k2="-1"
              k3="1"
            />
            <feColorMatrix type="matrix" values={theme.cardInsetColor} />
            <feBlend
              mode="normal"
              in2="shape"
              result="effect1_innerShadow_171_13"
            />
          </filter>
        </defs>
      </svg>
    </div>
  );
};

export function FolderComponent({
  color = "brand",
  size = "md",
  label,
  className,
  ...props
}: FolderComponentProps) {
  const reducedMotion = useReducedMotion();
  const theme: Theme = themes[color] ?? themes.brand;
  const scale = sizeScales[size] ?? 0.85;
  const [isHovered, setIsHovered] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const effectiveHovered = reducedMotion ? false : isHovered;
  const effectiveOpen = reducedMotion ? false : isOpen;

  return (
    <div
      data-slot="folder"
      className={cn("rare-folder-wrap", className)}
      {...props}
    >
      <div
        className="relative cursor-pointer select-none"
        style={{
          width: BASE_WIDTH * scale,
          height: BASE_HEIGHT * scale,
          touchAction: "manipulation",
          WebkitTapHighlightColor: "transparent",
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setIsOpen(false);
        }}
        onClick={() => setIsOpen((o) => !o)}
        role="button"
        tabIndex={0}
        aria-label={label ?? "文件夹展示"}
      >
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: "50%",
            width: BASE_WIDTH,
            height: BASE_HEIGHT,
            transform: `translate(-50%, -50%) scale(${scale})`,
            perspective: 800 * scale,
          }}
        >
          {/* Back folder body */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
            }}
          >
            <div
              style={{
                width: BASE_WIDTH,
                height: BASE_HEIGHT,
                borderRadius: 25,
                backgroundColor: theme.backFill,
                boxShadow: theme.backInsetShadow,
              }}
            />
          </div>

          {/* Fanning Cards */}
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <motion.div
              style={{ position: "absolute" }}
              animate={{
                y: effectiveOpen ? -160 : effectiveHovered ? -30 : -10,
                x: effectiveOpen ? 70 : 40,
                rotate: effectiveOpen ? 18 : effectiveHovered ? 14 : 10,
              }}
              transition={{
                type: "spring",
                stiffness: 120,
                damping: 13,
                delay: effectiveOpen ? 0.1 : effectiveHovered ? 0.12 : 0,
              }}
            >
              <Card id={1} theme={theme} />
            </motion.div>
            <motion.div
              style={{ position: "absolute" }}
              animate={{
                y: effectiveOpen ? -180 : effectiveHovered ? -35 : -20,
                x: effectiveOpen ? 0 : 3,
                rotate: effectiveOpen ? -3 : effectiveHovered ? -1 : 2,
              }}
              transition={{
                type: "spring",
                stiffness: 120,
                damping: 13,
                delay: effectiveOpen ? 0.05 : effectiveHovered ? 0.06 : 0,
              }}
            >
              <Card id={2} theme={theme} />
            </motion.div>
            <motion.div
              style={{ position: "absolute" }}
              animate={{
                y: effectiveOpen ? -170 : effectiveHovered ? -44 : -22,
                x: effectiveOpen ? -65 : -40,
                rotate: effectiveOpen ? -14 : effectiveHovered ? -9 : -5,
              }}
              transition={{
                type: "spring",
                stiffness: 120,
                damping: 13,
                delay: 0,
              }}
            >
              <Card id={3} theme={theme} />
            </motion.div>
          </div>

          {/* Front Flap */}
          <motion.div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              marginTop: 16,
              transformOrigin: "bottom center",
              transformStyle: "preserve-3d",
              width: 321,
              height: 241,
            }}
            animate={{
              rotateX: effectiveOpen ? -55 : effectiveHovered ? -45 : -15,
            }}
            transition={{ type: "spring", stiffness: 120, damping: 14 }}
          >
            <div
              style={{
                position: "absolute",
                inset: 0,
                backdropFilter: "blur(6px)",
                WebkitBackdropFilter: "blur(6px)",
                clipPath: `path('${FLAP_PATH}')`,
                WebkitClipPath: `path('${FLAP_PATH}')`,
                transform: "translateZ(0)",
                backfaceVisibility: "hidden",
                WebkitBackfaceVisibility: "hidden",
              }}
            />
            <svg
              style={{ position: "absolute", inset: 0 }}
              width="321"
              height="241"
              viewBox="0 0 321 241"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g filter="url(#filter0_i_flap)">
                <path
                  d={FLAP_PATH}
                  fill={theme.flapFill}
                  fillOpacity={theme.flapFillOpacity}
                />
                <path
                  d="M25 0.5H136.084C142.905 0.5 149.417 3.3431 154.054 8.3457L177.713 33.874C182.539 39.0808 189.317 42.04 196.416 42.04H296C309.531 42.04 320.5 53.0092 320.5 66.54V216C320.5 229.531 309.531 240.5 296 240.5H25C11.469 240.5 0.5 229.531 0.5 216V25C0.5 11.469 11.469 0.5 25 0.5Z"
                  stroke={theme.flapStroke}
                />
              </g>
              <defs>
                <filter
                  id="filter0_i_flap"
                  x="-25.4"
                  y="-25.4"
                  width="371.8"
                  height="291.8"
                  filterUnits="userSpaceOnUse"
                  colorInterpolationFilters="sRGB"
                >
                  <feFlood floodOpacity="0" result="BackgroundImageFix" />
                  <feBlend
                    mode="normal"
                    in="SourceGraphic"
                    in2="BackgroundImageFix"
                    result="shape"
                  />
                  <feColorMatrix
                    in="SourceAlpha"
                    type="matrix"
                    values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
                    result="hardAlpha"
                  />
                  <feOffset />
                  <feGaussianBlur stdDeviation="2.65" />
                  <feComposite
                    in2="hardAlpha"
                    operator="arithmetic"
                    k2="-1"
                    k3="1"
                  />
                  <feColorMatrix type="matrix" values={theme.flapInsetColor} />
                  <feBlend
                    mode="normal"
                    in2="shape"
                    result="effect1_innerShadow_flap"
                  />
                </filter>
              </defs>
            </svg>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

export default FolderComponent;
