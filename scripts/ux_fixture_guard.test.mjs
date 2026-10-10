import assert from "node:assert/strict";
import test from "node:test";
import {validateIsolatedFixtures} from "./ux_fixture_guard.mjs";
const environment={DATABASE_URL:"postgres://local:secret@127.0.0.1:5432/filesmanage_ux_test",FILESMANAGE_UX_FIXTURE_DB:"filesmanage_ux_test"};
const good={base:"http://127.0.0.1:18092",args:["--isolated-fixtures","--base","http://127.0.0.1:18092"],env:environment,explicitBase:true};
test("dedicated local test database and explicitly isolated port accepted",()=>{
 assert.equal(validateIsolatedFixtures(good).ok,true);
});
test("default developer service is never eligible",()=>{
 assert.equal(validateIsolatedFixtures({...good,base:"http://127.0.0.1:18091"}).ok,false);
});
test("an explicit override without DB verification is rejected",()=>{
 assert.equal(validateIsolatedFixtures({...good,env:{...environment,FILESMANAGE_UX_FIXTURE_DB:"filesmanage_v21"}}).ok,false);
});
test("a production hostname cannot be an isolated target",()=>{
 assert.equal(validateIsolatedFixtures({...good,base:"http://10.144.144.1:18092"}).ok,false);
});
test("the isolation flag and explicit base are both mandatory",()=>{
 assert.equal(validateIsolatedFixtures({...good,args:[]}).ok,false);
 assert.equal(validateIsolatedFixtures({...good,explicitBase:false}).ok,false);
});
