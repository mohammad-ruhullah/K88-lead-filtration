import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbMvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbMvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdbEhWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdbEhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

export type DuckDBRuntimeStatus = 'idle' | 'initializing' | 'ready' | 'error';

export interface DuckDBRuntimeLifecycle {
  status: DuckDBRuntimeStatus;
  message: string;
  error: string | null;
}

export interface RegisteredCSVFile {
  sourceName: string;
  virtualPath: string;
  sizeBytes: number;
  lastModifiedMs: number;
}

const DUCKDB_BUNDLES: duckdb.DuckDBBundles = {
  mvp: {
    mainModule: duckdbMvpWasm,
    mainWorker: duckdbMvpWorker,
  },
  eh: {
    mainModule: duckdbEhWasm,
    mainWorker: duckdbEhWorker,
  },
};

const INITIAL_LIFECYCLE: DuckDBRuntimeLifecycle = {
  status: 'idle',
  message: 'DuckDB runtime has not started yet.',
  error: null,
};

type LifecycleListener = (lifecycle: DuckDBRuntimeLifecycle) => void;

class DuckDBRuntimeService {
  private db: duckdb.AsyncDuckDB | null = null;
  private worker: Worker | null = null;
  private connection: duckdb.AsyncDuckDBConnection | null = null;
  private initializePromise: Promise<duckdb.AsyncDuckDBConnection> | null = null;
  private lifecycle: DuckDBRuntimeLifecycle = INITIAL_LIFECYCLE;
  private listeners = new Set<LifecycleListener>();
  private registeredCSVFiles: RegisteredCSVFile[] = [];

  getLifecycle(): DuckDBRuntimeLifecycle {
    return this.lifecycle;
  }

  subscribe(listener: LifecycleListener): () => void {
    this.listeners.add(listener);
    listener(this.lifecycle);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<duckdb.AsyncDuckDBConnection> {
    if (this.connection) {
      return this.connection;
    }

    if (this.initializePromise) {
      return this.initializePromise;
    }

    this.initializePromise = this.initializeInternal();

    try {
      const connection = await this.initializePromise;
      this.connection = connection;
      this.updateLifecycle({
        status: 'ready',
        message: 'DuckDB-Wasm is ready in this browser tab.',
        error: null,
      });
      return connection;
    } catch (error) {
      this.updateLifecycle({
        status: 'error',
        message: 'DuckDB-Wasm failed to initialize.',
        error: this.formatError(error),
      });
      await this.safeTerminate();
      throw error;
    } finally {
      this.initializePromise = null;
    }
  }

  async getVersion(): Promise<string> {
    if (!this.db) {
      throw new Error('DuckDB runtime is not initialized.');
    }

    return this.db.getVersion();
  }

  getConnection(): duckdb.AsyncDuckDBConnection {
    if (!this.connection) {
      throw new Error('DuckDB connection is not available yet.');
    }

    return this.connection;
  }

  async copyFileToBuffer(fileName: string): Promise<Uint8Array> {
    if (!this.db) {
      throw new Error('DuckDB runtime is not initialized.');
    }

    return this.db.copyFileToBuffer(fileName);
  }

  async dropFile(fileName: string): Promise<void> {
    if (!this.db) {
      return;
    }

    await this.db.dropFile(fileName);
  }

  getRegisteredCSVFiles(): RegisteredCSVFile[] {
    return [...this.registeredCSVFiles];
  }

  async registerCSVFiles(files: File[]): Promise<RegisteredCSVFile[]> {
    if (files.length === 0) {
      await this.clearRegisteredCSVFiles();
      return [];
    }

    await this.initialize();

    if (!this.db) {
      throw new Error('DuckDB runtime is not initialized.');
    }

    await this.clearRegisteredCSVFiles();

    const sessionStamp = Date.now();
    const nextRegisteredFiles: RegisteredCSVFile[] = [];

    for (const [index, file] of files.entries()) {
      const safeName = this.sanitizeFileName(file.name);
      const virtualPath = `user_uploads/${sessionStamp}_${index}_${safeName}`;
      await this.db.registerFileHandle(
        virtualPath,
        file,
        duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
        true,
      );
      nextRegisteredFiles.push({
        sourceName: file.name,
        virtualPath,
        sizeBytes: file.size,
        lastModifiedMs: file.lastModified,
      });
    }

    this.registeredCSVFiles = nextRegisteredFiles;
    return [...nextRegisteredFiles];
  }

  /**
   * Registers a list of existing leads (from Airtable) as a virtual CSV file
   * so DuckDB can perform an anti-join for deduplication.
   */
  async registerExistingLeads(leads: { propertyId: string; ownerName: string }[]): Promise<void> {
    if (!this.db) {
      throw new Error('DuckDB runtime is not initialized.');
    }

    const virtualPath = 'airtable_existing_leads.csv';
    
    // Create CSV content from leads
    const header = 'PROPERTY_ID,OWNER_NAME\n';
    const rows = leads
      .map(
        (l) =>
          `"${l.propertyId.replace(/"/g, '""')}","${l.ownerName.replace(/"/g, '""')}"`
      )
      .join('\n');
    
    const blob = new Blob([header + rows], { type: 'text/csv' });
    
    await this.db.registerFileHandle(
      virtualPath,
      blob,
      duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
      true
    );
  }

  async clearRegisteredCSVFiles(): Promise<void> {
    if (!this.db) {
      this.registeredCSVFiles = [];
      return;
    }

    if (this.registeredCSVFiles.length === 0) {
      return;
    }

    const paths = this.registeredCSVFiles.map((file) => file.virtualPath);

    try {
      await this.db.dropFiles(paths);
    } catch {
      for (const path of paths) {
        try {
          await this.db.dropFile(path);
        } catch {
          // Ignore cleanup errors.
        }
      }
    }

    this.registeredCSVFiles = [];
  }

  async terminate(): Promise<void> {
    this.updateLifecycle({
      status: 'idle',
      message: 'DuckDB runtime has been terminated.',
      error: null,
    });
    await this.safeTerminate();
  }

  private async initializeInternal(): Promise<duckdb.AsyncDuckDBConnection> {
    this.updateLifecycle({
      status: 'initializing',
      message: 'Selecting the best DuckDB-Wasm bundle for this browser.',
      error: null,
    });

    const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);

    this.updateLifecycle({
      status: 'initializing',
      message: 'Starting DuckDB worker and loading WebAssembly module.',
      error: null,
    });

    this.worker = new Worker(bundle.mainWorker!);
    this.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), this.worker);
    await this.db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    this.updateLifecycle({
      status: 'initializing',
      message: 'Opening a long-lived database connection.',
      error: null,
    });

    return this.db.connect();
  }

  private async safeTerminate(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.close();
      } catch {
        // Ignore close errors during cleanup.
      }
    }

    if (this.db) {
      try {
        await this.db.terminate();
      } catch {
        // Ignore terminate errors during cleanup.
      }
    }

    this.connection = null;
    this.db = null;
    this.worker = null;
    this.registeredCSVFiles = [];
  }

  private updateLifecycle(nextLifecycle: DuckDBRuntimeLifecycle): void {
    this.lifecycle = nextLifecycle;
    for (const listener of this.listeners) {
      listener(nextLifecycle);
    }
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }

  private sanitizeFileName(fileName: string): string {
    return fileName.replace(/[^a-zA-Z0-9._-]+/g, '_');
  }
}

export const duckDBRuntimeService = new DuckDBRuntimeService();
