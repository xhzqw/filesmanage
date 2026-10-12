#!/usr/bin/env node
// Session reconciliation is a no-op for identical user state. This must
// remain a build gate: reconnects and heartbeats should not re-render all
// authenticated routes when /api/me returns the same data.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require=createRequire(new URL("../web/package.json",import.meta.url));
const {build}=require("esbuild");
const built=await build({entryPoints:["web/src/app/session.ts"],absWorkingDir:process.cwd(),
 platform:"node",format:"esm",bundle:true,write:false,logLevel:"silent"});
const {useSession}=await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].contents).toString("base64"));
const changes=[];
const stop=useSession.subscribe(state=>changes.push([state.user?.id??null,state.loading]));
const me={id:"u_1",displayName:"张三",isAdmin:false,mustChangePassword:false,departmentId:"dep_1",login:"u_1"};
useSession.getState().setUser(me);
assert.equal(changes.length,1);
const firstUser=useSession.getState().user;
useSession.getState().setUser({...me});
assert.equal(changes.length,1,"identical /api/me must not notify route subscribers");
assert.equal(useSession.getState().user,firstUser,"identical identity retains object reference");
useSession.getState().setLoading(true);
assert.equal(changes.length,1,"unchanged loading state must not notify");
useSession.getState().setLoading(false);
assert.equal(changes.length,2);
useSession.getState().setUser({...me,isAdmin:true});
assert.equal(changes.length,3,"admin privilege changes must propagate");
useSession.getState().setUser({...me,disabled:true});
assert.equal(changes.length,4,"enabled/disabled account changes must propagate");
useSession.getState().setUser(null);
assert.equal(changes.length,5,"session revocation must propagate immediately");
useSession.getState().setUser(null);
assert.equal(changes.length,5,"duplicate logout must not recreate route state");
stop();
console.log("SESSION_IDENTITY_PASS: no redundant route re-renders; privilege/revocation changes preserved");
