/**
 * Whether a post or comment shows as "Edited". One definition so the feed,
 * a single post, comments, myReview and the friend's-book page can never
 * disagree: edited means `edited_at` is set, and `edited_at` is only ever set
 * when the content itself changed (see communityService.updatePost).
 */
export function isEdited(editedAt: Date | null | undefined): boolean {
  return editedAt !== null && editedAt !== undefined;
}

/** Adds `isEdited` to a row that carries `editedAt`. */
export function withEditState<T extends { editedAt: Date | null }>(row: T): T & { isEdited: boolean } {
  return { ...row, isEdited: isEdited(row.editedAt) };
}
