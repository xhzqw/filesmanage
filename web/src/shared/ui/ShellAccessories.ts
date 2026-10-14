import {createContext,type ReactNode} from "react";
// App injects optional authenticated tools. The shared shell knows nothing
// about feature APIs or permissions, keeping layering one-way.
export const ShellAccessories=createContext<ReactNode>(null);
