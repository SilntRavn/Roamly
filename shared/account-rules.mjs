export const USERNAME_MAX_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 16;
export const USERNAME_PATTERN = "^[\\p{Script=Han}A-Za-z_]+$";
export const usernameCharacters = new RegExp(USERNAME_PATTERN, "u");
// Count Unicode characters, so Chinese, English and underscores each count as one.
export const characterCount = (value) => Array.from(value).length;
export const limitCharacters = (value, max) => Array.from(value).slice(0, max).join("");
