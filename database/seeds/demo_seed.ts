import path from 'node:path';
import { seedDemoClusterIfEmpty } from '../../src/server/demoData';
import { BedcareCluster } from '../../src/server/p2pCluster';

const cluster = new BedcareCluster({
  dataDir: path.resolve(process.cwd(), 'data'),
});
seedDemoClusterIfEmpty(cluster);
console.log('Đã khởi tạo dữ liệu demo BEDCARE cho 3 nút P2P.');
