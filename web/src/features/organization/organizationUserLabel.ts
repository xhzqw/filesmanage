import type {User} from "../../entities/user/model";

export function loginOf(user:User):string{return user.login??"";}
