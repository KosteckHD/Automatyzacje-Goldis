/** Request shape for the existing deletion re-authentication endpoint. */
export type DeletionStepUpRequestDto = Readonly<{
  currentPassword?: string;
  previewId?: string;
}>;

export type DeletionStepUpResponseDto = Readonly<{
  stepUpToken: string;
  expiresAt: string;
}>;
