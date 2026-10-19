import byteAvatar from "../assets/avatars/byte.svg";
import blazeAvatar from "../assets/avatars/blaze.svg";
import defaultAvatar from "../assets/avatars/default.svg";
import foxAvatar from "../assets/avatars/fox.svg";
import novaAvatar from "../assets/avatars/nova.svg";
import pipAvatar from "../assets/avatars/pip.svg";
import sherlockAvatar from "../assets/avatars/sherlock.svg";

export const AVATAR_IDS = [
  "sherlock",
  "fox",
  "blaze",
  "pip",
  "nova",
  "byte",
  "human",
  "default",
] as const;

export type AvatarId = (typeof AVATAR_IDS)[number];

export type AvatarSize = "card" | "game" | "chat" | "result";

export type AvatarState =
  | "online"
  | "disconnected"
  | "host"
  | "current"
  | "speaking"
  | "suspicious"
  | "eliminated"
  | "winner"
  | "selected";

export interface AvatarAsset {
  readonly id: AvatarId;
  readonly label: string;
  readonly src: string;
}

export const AVATAR_ASSETS: Readonly<Record<AvatarId, AvatarAsset>> = {
  sherlock: { id: "sherlock", label: "Sherlock", src: sherlockAvatar },
  fox: { id: "fox", label: "Fox", src: foxAvatar },
  blaze: { id: "blaze", label: "Blaze", src: blazeAvatar },
  pip: { id: "pip", label: "Pip", src: pipAvatar },
  nova: { id: "nova", label: "Nova", src: novaAvatar },
  byte: { id: "byte", label: "Byte", src: byteAvatar },
  human: { id: "human", label: "Human", src: defaultAvatar },
  default: { id: "default", label: "Default", src: defaultAvatar },
};

export const DEFAULT_AVATAR_ID: AvatarId = "default";
export const DEFAULT_AVATAR_SRC = AVATAR_ASSETS[DEFAULT_AVATAR_ID].src;

export function isAvatarId(value: unknown): value is AvatarId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AVATAR_ASSETS, value);
}

export function getAvatarAsset(value: unknown): AvatarAsset {
  return isAvatarId(value) ? AVATAR_ASSETS[value] : AVATAR_ASSETS[DEFAULT_AVATAR_ID];
}
