import { createContext } from "react";

export const ProfilePagingContext = createContext<((blocked: boolean) => void) | undefined>(undefined);
