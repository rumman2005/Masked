import { useEffect, useState, type ComponentPropsWithoutRef } from "react";

import {
  DEFAULT_AVATAR_SRC,
  getAvatarAsset,
  type AvatarId,
  type AvatarSize,
  type AvatarState,
} from "./avatarAssets";

type AvatarContainerProps = Omit<
  ComponentPropsWithoutRef<"span">,
  "aria-hidden" | "aria-label" | "children" | "className"
>;

export interface AvatarProps extends AvatarContainerProps {
  /** Stable local asset id. Unknown runtime values resolve to the default avatar. */
  avatarId?: AvatarId;
  /** Layout hook for the four supported contexts. */
  size?: AvatarSize;
  /** One state or several simultaneous visual states. */
  states?: AvatarState | readonly AvatarState[];
  /** Accessible name for the avatar. Defaults to the asset label plus "avatar". */
  alt?: string;
  /** Hide the avatar from assistive technology when it is purely decorative. */
  decorative?: boolean;
  className?: string;
  "aria-hidden"?: boolean | "false" | "true";
  "aria-label"?: string;
}

function normalizeStates(states: AvatarProps["states"]): readonly AvatarState[] {
  if (!states) {
    return [];
  }

  return typeof states === "string" ? [states] : states;
}

/**
 * A local, CSS-ready avatar primitive. The component owns no animation styles;
 * state classes and data attributes are the integration surface for the app.
 */
export function Avatar({
  avatarId = "default",
  size = "game",
  states,
  alt,
  decorative = false,
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  ...containerProps
}: AvatarProps) {
  const asset = getAvatarAsset(avatarId);
  const avatarStates = normalizeStates(states);
  const imageAlt = alt ?? `${asset.label} avatar`;
  const isDecorative =
    decorative ||
    ariaHidden === true ||
    ariaHidden === "true" ||
    (imageAlt.length === 0 && !ariaLabel);

  const [failedSource, setFailedSource] = useState<string | null>(null);
  const [fallbackUnavailable, setFallbackUnavailable] = useState(false);

  useEffect(() => {
    setFailedSource(null);
    setFallbackUnavailable(false);
  }, [asset.src]);

  const usingDefaultFallback = failedSource === asset.src && asset.src !== DEFAULT_AVATAR_SRC;
  const imageSource = usingDefaultFallback ? DEFAULT_AVATAR_SRC : asset.src;
  const showPlaceholder = fallbackUnavailable;
  const stateClasses = avatarStates.flatMap((state) => [`avatar--${state}`, `is-${state}`]);
  const classes = [
    "avatar",
    `avatar--${size}`,
    ...stateClasses,
    usingDefaultFallback ? "avatar--fallback" : "",
    showPlaceholder ? "avatar--fallback-unavailable" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  function handleImageError(): void {
    if (imageSource !== DEFAULT_AVATAR_SRC) {
      setFailedSource(asset.src);
      return;
    }

    setFallbackUnavailable(true);
  }

  return (
    <span
      {...containerProps}
      className={classes}
      data-avatar-id={asset.id}
      data-avatar-size={size}
      data-avatar-state={avatarStates.length > 0 ? avatarStates.join(" ") : undefined}
      data-avatar-fallback={
        showPlaceholder ? "placeholder" : usingDefaultFallback ? "default" : undefined
      }
      aria-hidden={isDecorative ? true : ariaHidden}
      aria-label={showPlaceholder && !isDecorative ? ariaLabel ?? imageAlt : undefined}
      role={showPlaceholder && !isDecorative ? "img" : containerProps.role}
    >
      {showPlaceholder ? (
        <span className="avatar__image avatar__image--placeholder" aria-hidden="true" />
      ) : (
        <img
          key={imageSource}
          className="avatar__image"
          src={imageSource}
          alt={isDecorative ? "" : imageAlt}
          aria-hidden={isDecorative ? true : ariaHidden}
          aria-label={isDecorative ? undefined : ariaLabel}
          draggable={false}
          decoding="async"
          onError={handleImageError}
        />
      )}
    </span>
  );
}

export {
  AVATAR_ASSETS,
  AVATAR_IDS,
  DEFAULT_AVATAR_ID,
  DEFAULT_AVATAR_SRC,
  getAvatarAsset,
  isAvatarId,
} from "./avatarAssets";
export type { AvatarAsset, AvatarId, AvatarSize, AvatarState } from "./avatarAssets";

export default Avatar;
