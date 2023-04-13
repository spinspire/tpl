import PocketBase, { ListResult, Record as PBRecord, type AuthProviderInfo } from "pocketbase";
import type { Admin } from "pocketbase";
import { readable, type Readable, type Subscriber } from "svelte/store";
import type { Page } from "@sveltejs/kit";
import { goto } from "$app/navigation";
import { browser } from "$app/environment";

export const client = new PocketBase();

export const authModel = readable<PBRecord | Admin | null>(null, function (set) {
  client.authStore.onChange((token, model) => {
    set(model);
  }, true);
});

/*
 * Save (create/update) a record (a plain object). Automatically converts to
 * FormData if needed.
 */
export async function save(collection: string, record: any, create = false) {
  // convert obj to FormData in case one of the fields is instanceof FileList
  const data = object2formdata(record);
  if (record.id && !create) {
    // "create" flag overrides update
    return await client.collection(collection).update(record.id, data);
  } else {
    return await client.collection(collection).create(data);
  }
}

// convert obj to FormData in case one of the fields is instanceof FileList
function object2formdata(obj: {}) {
  // check if any field's value is an instanceof FileList
  if (!Object.values(obj).some((val) => val instanceof FileList || val instanceof File)) {
    // if not, just return the original object
    return obj;
  }
  // otherwise, build FormData from obj
  const fd = new FormData();
  for (const [key, val] of Object.entries(obj)) {
    if (val instanceof FileList) {
      for (const file of val) {
        fd.append(key, file);
      }
    } else if (val instanceof File) {
      // handle File before "object" so that it doesn't get serialized as JSON
      fd.append(key, val);
    } else if (typeof val === "object") {
      fd.append(key, JSON.stringify(val));
    } else {
      fd.append(key, val as any);
    }
  }
  return fd;
}

export interface PageStore<T = any> extends Readable<ListResult<T>> {
  setPage(newpage: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
}

export function watch(
  idOrName: string,
  queryParams = {} as any,
  page = 1,
  perPage = 20
): PageStore {
  const collection = client.collection(idOrName);
  let result = new ListResult(page, perPage, 0, 0, [] as Record<any, any>[]);
  let set: Subscriber<ListResult<Record<any, any>>>;
  const store = readable(result, (_set) => {
    set = _set;
    // fetch first page
    collection.getList(page, perPage, queryParams).then((r) => set((result = r)));
    // watch for changes (only if you're in the browser)
    if (browser)
      collection.subscribe("*", ({ action, record }) => {
        (async function (action: string) {
          // see https://github.com/pocketbase/pocketbase/discussions/505
          async function expand(expand: any, record: any) {
            return expand ? await collection.getOne(record.id, { expand }) : record;
          }
          switch (action) {
            case "update":
              record = await expand(queryParams.expand, record);
              return result.items.map((item) => (item.id === record.id ? record : item));
            case "create":
              record = await expand(queryParams.expand, record);
              const index = result.items.findIndex((r) => r.id === record.id);
              // replace existing if found, otherwise append
              if (index >= 0) {
                result.items[index] = record;
                return result.items;
              } else {
                return [...result.items, record];
              }
            case "delete":
              return result.items.filter((item) => item.id !== record.id);
          }
          return result.items;
        })(action).then((items) => set((result = { ...result, items })));
      });
  });
  async function setPage(newpage: number) {
    const { page, totalPages, perPage } = result;
    if (page > 0 && page <= totalPages) {
      set((result = await collection.getList(newpage, perPage, queryParams)));
    }
  }
  return {
    ...store,
    setPage,
    async next() {
      setPage(result.page + 1);
    },
    async prev() {
      setPage(result.page - 1);
    },
  };
}

export async function handleRedirect(page: Page, authCollection = "users") {
  const current = page.url;
  const [redirectUri] = current.toString().split("?");

  const code = current.searchParams.get("code");
  if (code) {
    const provider = JSON.parse(sessionStorage.getItem("provider") ?? "{}") as AuthProviderInfo;
    if (provider.state !== current.searchParams.get("state")) {
      throw "State parameters don't match.";
    }
    const authResponse = await client
      .collection(authCollection)
      .authWithOAuth2(provider.name, code, provider.codeVerifier, redirectUri, {
        emailVisibility: true,
      });
    // update user "record" if "meta" has info it doesn't have
    const { meta, record } = authResponse;
    let changes = {} as { [key: string]: any };
    if (!record.name && meta?.name) {
      changes.name = meta.name;
    }
    if (!record.avatar && meta?.avatarUrl) {
      const response = await fetch(meta.avatarUrl);
      if (response.ok) {
        const type = response.headers.get("content-type") ?? "image/jpeg";
        changes.avatar = new File([await response.blob()], "avatar", { type });
      }
    }
    if (Object.keys(changes).length) {
      await save(authCollection, { ...record, ...changes });
    }
    const redirect = sessionStorage.getItem("redirect");
    if (redirect) {
      goto(redirect, {
        replaceState: true,
      });
    }
  }
}