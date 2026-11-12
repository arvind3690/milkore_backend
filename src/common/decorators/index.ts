import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Route is reachable without an access token (a token, if sent, is still read). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const RESPONSE_MESSAGE_KEY = 'responseMessage';
/** Sets the `message` field of the response envelope. */
export const ResponseMessage = (message: string) => SetMetadata(RESPONSE_MESSAGE_KEY, message);

export const RAW_RESPONSE_KEY = 'rawResponse';
/** Skips the envelope (file streams only). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);

export const ROLES_KEY = 'roles';
/** Restricts a route to the given user roles (CUSTOMER, VENDOR). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
